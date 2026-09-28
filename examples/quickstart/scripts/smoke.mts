/**
 * End-to-end smoke test of the acp-hub harness, using a fake ACP agent so
 * it runs on any machine without real agents installed.
 *
 *   pnpm --filter @cc-heart/acp-hub-example-quickstart smoke
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAcpAgentAdapter,
  readExtensionCapability,
  type SessionEvent,
} from '@cc-heart/acp-hub-adapter-codex';

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeAgentPath = path.join(here, '..', '..', 'fake-agent', 'agent.mjs');
const events: SessionEvent[] = [];

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`SMOKE FAILED: ${message}`);
}

const adapter = createAcpAgentAdapter(
  'fake-agent',
  { command: process.execPath, args: [fakeAgentPath] },
  { initializeTimeoutMs: 15_000 }
);

// 1. Handshake
const capabilities = await adapter.connect();
assert(capabilities.protocolVersion > 0, 'initialize returned a protocol version');
assert(capabilities.supportsLoad === true, 'agent advertises loadSession');
assert(readExtensionCapability<{ version: number }>(capabilities, 'fake-agent')?.version === 1,
  'extension capability readable from agentCapabilities._meta');
console.log(`[smoke] handshake ok (protocol=${capabilities.protocolVersion})`);

// 2. New session + full turn: chunks, tool call, permission round-trip, plan
const session = await adapter.createSession({ cwd: process.cwd() });
const turn = session.prompt('hi');
turn.then(() => {
  setTimeout(() => void session.dispose(), 100);
});

for await (const event of session.events) {
  events.push(event);
  if (event.type === 'permission_request') {
    assert(event.toolCall?.toolCallId === 't1', 'permission request carries the tool call');
    assert(event.options.some((option) => option.optionId === 'allow'), 'allow option present');
    await session.respondPermission(event.requestId, 'allow');
  }
}

const result = await turn;
const deltas = events.flatMap((event) => (event.type === 'message_delta' ? [event.text] : []));
assert(deltas.join('') === 'Hello from fake agent', `streamed text assembles (got: ${deltas.join('')})`);
const statuses = events
  .filter((event) => event.type === 'tool_call' || event.type === 'tool_call_update')
  .map((event) => (event.type === 'tool_call' ? event.toolCall.status : event.toolCall.status));
assert(statuses.includes('in_progress') && statuses.includes('completed'),
  `tool lifecycle visible (got: ${statuses.join(',')})`);
assert(events.some((event) => event.type === 'permission_request'), 'permission request surfaced');
assert(events.some((event) => event.type === 'plan'), 'plan update surfaced');
assert(result.stopReason === 'end_turn', `turn completed (got: ${result.stopReason})`);
console.log(`[smoke] turn ok — ${events.length} events, stopReason=${result.stopReason}`);

// 3. Resume path (session/load)
const resumed = await adapter.createSession({ cwd: process.cwd(), resumeSessionId: 'fake-session-1' });
assert(resumed.id === 'fake-session-1', 'resume keeps the requested session id');
await resumed.dispose();
console.log('[smoke] resume ok');

await adapter.dispose();
console.log('SMOKE OK');
process.exit(0);
