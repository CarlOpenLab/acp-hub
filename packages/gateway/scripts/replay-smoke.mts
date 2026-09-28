/**
 * Multi-client convergence test — the acp-hub equivalent of "phone opens
 * mid-stream and catches up to the same node".
 *
 * Scenario: client A watches a turn live; clients B/C/D join afterwards with
 * different `lastSeq` offsets; the test asserts every client ends up with the
 * exact same frame sequence (no gaps, no duplicates, identical payloads), a
 * partial replay starts exactly at lastSeq+1, and an ahead-of-log lastSeq is
 * rejected.
 *
 *   pnpm gateway:replay
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGatewayServer } from '../src/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeAgentPath = path.join(here, '..', '..', '..', 'examples', 'fake-agent', 'agent.mjs');

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`REPLAY SMOKE FAILED: ${message}`);
}

interface Frame {
  seq: number; // 0 = unsequenced (hello)
  kind: string;
  payload: string;
}

/** Read SSE frames until `until` matches a frame, then cancel the stream. */
async function readFrames(
  body: ReadableStream<Uint8Array>,
  until: (message: { seq?: number; kind: string }) => boolean
): Promise<Frame[]> {
  const frames: Frame[] = [];
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';
  outer: while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let separator = buffer.indexOf('\n\n');
    while (separator >= 0) {
      const frameText = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      const dataLine = frameText.split('\n').find((line) => line.startsWith('data: '));
      if (dataLine) {
        const payload = dataLine.slice(6);
        const message = JSON.parse(payload) as { seq?: number; kind: string };
        frames.push({ seq: typeof message.seq === 'number' ? message.seq : 0, kind: message.kind, payload });
        if (until(message)) break outer;
      }
      separator = buffer.indexOf('\n\n');
    }
  }
  await reader.cancel().catch(() => {});
  return frames;
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

  const created = await fetch(`${base}/api/agents/fake/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: process.cwd() }),
  });
  const { sessionId } = (await created.json()) as { sessionId: string };

  // Client A: subscribes BEFORE the turn and watches it live.
  const resA = await fetch(`${base}/api/sessions/${sessionId}/events`);
  assert(resA.ok, 'client A subscribed');

  const prompted = await fetch(`${base}/api/sessions/${sessionId}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'hi' }),
  });
  assert(prompted.status === 202, 'prompt accepted');

  const framesA = await readFrames(resA.body!, (message) => message.kind === 'turn_completed');
  const loggedA = framesA.filter((frame) => frame.seq > 0);

  // 1. Per-session seq is gapless and starts at 1.
  const seqsA = loggedA.map((frame) => frame.seq);
  assert(
    seqsA.every((seq, index) => seq === index + 1),
    `seq must be 1..N consecutive (got ${seqsA.join(',')})`
  );
  const head = seqsA.length;
  assert(head >= 5, `expected a real turn's worth of frames (got ${head})`);
  console.log(`[replay] client A watched the turn live: ${head} frames, seq 1..${head}`);

  // 2. Client B: reconnects with lastSeq=0 → full replay identical to A.
  const resB = await fetch(`${base}/api/sessions/${sessionId}/events?lastSeq=0`);
  const framesB = await readFrames(resB.body!, (message) => message.kind === 'turn_completed');
  const loggedB = framesB.filter((frame) => frame.seq > 0);
  assert(
    JSON.stringify(loggedB.map((frame) => frame.payload)) === JSON.stringify(loggedA.map((frame) => frame.payload)),
    'full replay (lastSeq=0) must reproduce client A frames byte-for-byte'
  );
  console.log('[replay] client B (lastSeq=0) converged: identical frame sequence');

  // 3. Client C: lastSeq=1 → everything except frame 1.
  const resC = await fetch(`${base}/api/sessions/${sessionId}/events?lastSeq=1`);
  const framesC = await readFrames(resC.body!, (message) => message.kind === 'turn_completed');
  const loggedC = framesC.filter((frame) => frame.seq > 0);
  assert(
    loggedC[0]?.seq === 2,
    `partial replay must start at lastSeq+1 (got first seq ${loggedC[0]?.seq})`
  );
  assert(
    JSON.stringify(loggedC.map((frame) => frame.seq)) === JSON.stringify(seqsA.slice(1)),
    'partial replay (lastSeq=1) must match A minus frame 1'
  );
  console.log('[replay] client C (lastSeq=1) converged: frames 2..head, exactly A minus frame 1');

  // 4. Client D: late join mid-history, lastSeq=3.
  const resD = await fetch(`${base}/api/sessions/${sessionId}/events?lastSeq=3`);
  const framesD = await readFrames(resD.body!, (message) => message.kind === 'turn_completed');
  const loggedD = framesD.filter((frame) => frame.seq > 0);
  assert(loggedD[0]?.seq === 4, `first replayed frame must be 4 (got ${loggedD[0]?.seq})`);
  assert(
    JSON.stringify(loggedD.map((frame) => frame.seq)) === JSON.stringify(seqsA.slice(3)),
    'partial replay (lastSeq=3) must match A minus frames 1..3'
  );
  console.log('[replay] client D (lastSeq=3) converged: frames 4..head');

  // 5. A lastSeq ahead of the log is rejected (surfaces client bugs instead
  //    of silently diverging).
  const ahead = await fetch(`${base}/api/sessions/${sessionId}/events?lastSeq=999`);
  assert(ahead.status === 400, `ahead-of-log lastSeq must 400 (got ${ahead.status})`);

  // 6. Garbage lastSeq is rejected.
  const garbage = await fetch(`${base}/api/sessions/${sessionId}/events?lastSeq=abc`);
  assert(garbage.status === 400, `non-numeric lastSeq must 400 (got ${garbage.status})`);

  const removed = await fetch(`${base}/api/sessions/${sessionId}`, { method: 'DELETE' });
  assert(removed.status === 200, 'session deleted');

  console.log('REPLAY SMOKE OK');
} finally {
  await gateway.close();
}
