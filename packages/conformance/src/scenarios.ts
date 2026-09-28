import type {
  AdapterError,
  AgentAdapter,
  AgentCapabilities,
  AgentSession,
  SessionEvent,
} from '@cc-heart/acp-hub-core';

export const KNOWN_EVENT_TYPES = new Set([
  'message_delta',
  'thought_delta',
  'tool_call',
  'tool_call_update',
  'plan',
  'usage',
  'session_info',
  'mode_update',
  'commands_update',
  'permission_request',
  'agent_error',
  'raw',
]);

export interface ScenarioContext {
  adapter: AgentAdapter;
  capabilities: AgentCapabilities;
  /** Fresh session for this scenario; the runner disposes it afterwards. */
  session: AgentSession;
  /** Live-collected event list (drained concurrently with the scenario). */
  events: SessionEvent[];
  assert(condition: boolean, message: string): void;
}

export interface Scenario {
  id: string;
  description: string;
  /** Return false to skip (e.g. capability-gated scenarios). */
  applies?: (capabilities: AgentCapabilities) => boolean;
  run(context: ScenarioContext): void | Promise<void>;
}

const VALID_STOP_REASONS = new Set(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled']);

function isAdapterError(value: unknown): value is AdapterError {
  return value instanceof Error && 'code' in value && typeof (value as { code: unknown }).code === 'string';
}

/**
 * Poll the live event list until a matching event shows up (or timeout).
 * Trailing notifications may land a few microtasks after the prompt
 * response resolves, so late-turn assertions wait instead of racing.
 */
async function waitForEvent(
  events: SessionEvent[],
  predicate: (event: SessionEvent) => boolean,
  timeoutMs = 2000
): Promise<SessionEvent | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = events.find(predicate);
    if (found !== undefined) return found;
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Tolerant scenarios that every conforming ACP agent must pass.
 * Run against real agents (codex, claude, …).
 */
export const BASELINE_SCENARIOS: Scenario[] = [
  {
    id: 'handshake',
    description: 'initialize returns a protocol version and capability object',
    run: ({ capabilities, assert }) => {
      assert(capabilities.protocolVersion > 0, 'protocolVersion must be positive');
      assert(typeof capabilities.raw.agentCapabilities === 'object', 'agentCapabilities must be an object');
    },
  },
  {
    id: 'turn-completes',
    description: 'a prompt resolves with a valid stopReason and at least one event',
    run: async ({ session, events, assert }) => {
      const result = await session.prompt('Reply with exactly: ok');
      assert(
        VALID_STOP_REASONS.has(result.stopReason),
        `stopReason must be one of ${[...VALID_STOP_REASONS].join('|')} (got ${result.stopReason})`
      );
      assert(events.length >= 1, 'at least one session event must be emitted during a turn');
    },
  },
  {
    id: 'events-are-typed',
    description: 'every event matches the unified SessionEvent union',
    run: async ({ events, assert }) => {
      const unknown = events.filter((event) => !KNOWN_EVENT_TYPES.has(event.type));
      assert(unknown.length === 0, `unknown event types: ${unknown.map((e) => e.type).join(', ')}`);
    },
  },
  {
    id: 'single-active-prompt',
    description: 'a second prompt while one is active is rejected',
    run: async ({ session, assert }) => {
      const first = session.prompt('Count slowly to three');
      try {
        await session.prompt('second prompt');
        assert(false, 'second prompt must be rejected while one is active');
      } catch (error) {
        assert(isAdapterError(error) && error.code === 'prompt_active', `expected prompt_active, got: ${String(error)}`);
      } finally {
        await first.catch(() => {});
      }
    },
  },
  {
    id: 'session-resume',
    description: 'session/load restores the requested session id',
    applies: (capabilities) => capabilities.supportsLoad,
    run: async ({ adapter, session, assert }) => {
      const resumed = await adapter.createSession({ cwd: process.cwd(), resumeSessionId: session.id });
      try {
        assert(resumed.id === session.id, `resumed id mismatch: ${resumed.id} !== ${session.id}`);
      } finally {
        await resumed.dispose();
      }
    },
  },
];

/**
 * Strict scenarios for the bundled fake agent — verify the harness
 * translation layer itself (streaming, commands, tool lifecycle,
 * permission round-trip, plan, batching).
 */
export const FAKE_AGENT_SCENARIOS: Scenario[] = [
  ...BASELINE_SCENARIOS,
  {
    id: 'streaming-assembles',
    description: 'message deltas stream and assemble in order',
    run: async ({ session, events, assert }) => {
      const result = await session.prompt('hi');
      const text = events
        .flatMap((event) => (event.type === 'message_delta' ? [event.text] : []))
        .join('');
      assert(text === 'Hello from fake agent', `assembled text mismatch: ${JSON.stringify(text)}`);
      assert(result.stopReason === 'end_turn', `expected end_turn, got ${result.stopReason}`);
    },
  },
  {
    id: 'commands-surfaced',
    description: 'available_commands_update is translated to commands_update',
    run: async ({ session, events, assert }) => {
      await session.prompt('hi');
      const found = await waitForEvent(events, (event) => event.type === 'commands_update');
      assert(found !== undefined, 'expected one commands_update');
      if (found !== undefined && found.type === 'commands_update') {
        assert(found.commands.some((command) => command.name === '/fake-help'),
          'fake slash command must be present');
      }
    },
  },
  {
    id: 'tool-lifecycle',
    description: 'tool_call then tool_call_update expose the status lifecycle',
    run: async ({ session, events, assert }) => {
      await session.prompt('hi');
      const completed = await waitForEvent(
        events,
        (event) => event.type === 'tool_call_update' && event.toolCall.status === 'completed'
      );
      assert(completed !== undefined, 'tool call must complete');
      const opened = await waitForEvent(events, (event) => event.type === 'tool_call');
      assert(opened !== undefined, 'tool call must open as in_progress');
    },
  },
  {
    id: 'permission-roundtrip',
    description: 'permission request surfaces with a requestId and the answer reaches the agent',
    run: async ({ session, events, assert }) => {
      const result = await session.prompt('hi');
      const requests = events.filter((event) => event.type === 'permission_request');
      assert(requests.length === 1, `expected one permission_request (got ${requests.length})`);
      const request = requests[0];
      if (request !== undefined && request.type === 'permission_request') {
        assert(typeof request.requestId === 'string', 'permission_request must carry requestId');
        assert(request.options.some((option) => option.kind === 'allow_once'), 'allow_once option present');
      }
      assert(result.stopReason === 'end_turn', `allow path must end the turn (got ${result.stopReason})`);
    },
  },
  {
    id: 'plan-update',
    description: 'plan update surfaces as a unified plan event',
    run: async ({ session, events, assert }) => {
      await session.prompt('hi');
      const found = await waitForEvent(events, (event) => event.type === 'plan');
      assert(found !== undefined, 'plan event expected');
      if (found !== undefined && found.type === 'plan') {
        assert(found.entries.some((entry) => entry.content === 'say hi'), 'plan entry content present');
      }
    },
  },
];
