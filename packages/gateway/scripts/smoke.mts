/**
 * Gateway smoke test: boots the HTTP+SSE gateway over the fake ACP agent
 * and drives the full downstream flow with plain fetch — the same way a
 * web/mobile consumer would.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGatewayServer } from '../src/server.js';
import type { SessionEvent } from 'acp-hub-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeAgentPath = path.join(here, '..', '..', '..', 'examples', 'fake-agent', 'agent.mjs');

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`GATEWAY SMOKE FAILED: ${message}`);
}

const gateway = createGatewayServer({
  agents: {
    fake: {
      launch: { command: process.execPath, args: [fakeAgentPath] },
      permissionPolicy: 'allow-once',
    },
  },
  batching: { firstWindowMs: 10, windowMs: 50 },
});

try {
  const port = await gateway.listen(0);
  const base = `http://127.0.0.1:${port}`;

  const health = await fetch(`${base}/api/health`);
  assert(health.ok, 'health endpoint responds');
  assert(((await health.json()) as { agents: string[] }).agents.includes('fake'), 'fake agent registered');

  const created = await fetch(`${base}/api/agents/fake/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: process.cwd() }),
  });
  assert(created.status === 200, `session created (status ${created.status})`);
  const { sessionId } = (await created.json()) as { sessionId: string };
  assert(typeof sessionId === 'string' && sessionId.length > 0, 'sessionId returned');

  // Subscribe to SSE before prompting.
  const events = await fetch(`${base}/api/sessions/${sessionId}/events`);
  assert(events.ok && events.headers.get('content-type')?.includes('text/event-stream'), 'SSE stream opens');

  const collected: SessionEvent[] = [];
  let stopReason: string | undefined;
  let sawClosed = false;
  const decoder = new TextDecoder();
  const reader = events.body!.getReader();
  let buffer = '';

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('SSE timed out waiting for turn_completed')), 15_000)
  );
  const readUntilTurnCompletes = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let separator = buffer.indexOf('\n\n');
      while (separator >= 0) {
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const line = frame.split('\n').find((candidate) => candidate.startsWith('data: '));
        if (line) {
          const message = JSON.parse(line.slice(6)) as
            | { kind: 'hello' }
            | { kind: 'events'; events: SessionEvent[] }
            | { kind: 'turn_completed'; stopReason: string }
            | { kind: 'closed' }
            | { kind: 'error'; message: string };
          if (message.kind === 'events') collected.push(...message.events);
          else if (message.kind === 'turn_completed') stopReason = message.stopReason;
          else if (message.kind === 'closed') sawClosed = true;
          else if (message.kind === 'error') throw new Error(`gateway error: ${message.message}`);
        }
        separator = buffer.indexOf('\n\n');
      }
      if (stopReason !== undefined) break;
    }
  })();

  const prompted = await fetch(`${base}/api/sessions/${sessionId}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'hi' }),
  });
  assert(prompted.status === 202, `prompt accepted (status ${prompted.status})`);

  const doublePrompt = await fetch(`${base}/api/sessions/${sessionId}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'second' }),
  });
  assert(doublePrompt.status === 409, 'concurrent prompt rejected with 409');

  await Promise.race([readUntilTurnCompletes, timeout]);
  await reader.cancel().catch(() => {});
  const text = collected
    .flatMap((event) => (event.type === 'message_delta' ? [event.text] : []))
    .join('');
  assert(text === 'Hello from fake agent', `streamed text over SSE (got: ${JSON.stringify(text)})`);
  assert(stopReason === 'end_turn', `turn_completed with end_turn (got ${stopReason})`);
  assert(collected.some((event) => event.type === 'commands_update'), 'commands_update delivered');
  assert(
    collected.some((event) => event.type === 'tool_call_update' && event.toolCall.status === 'completed'),
    'permission auto-allowed and tool completed'
  );

  const removed = await fetch(`${base}/api/sessions/${sessionId}`, { method: 'DELETE' });
  assert(removed.status === 200, 'session deleted');
  const afterDelete = await fetch(`${base}/api/sessions/${sessionId}`);
  assert(afterDelete.status === 404, 'deleted session is gone');
  void sawClosed;

  console.log('GATEWAY SMOKE OK');
} finally {
  await gateway.close();
}
