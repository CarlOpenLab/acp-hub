import type { SessionEvent } from '../events.js';
import { EventQueue } from './queue.js';

export interface BatchOptions {
  /** Coalesce window after the first delta of a burst. Default 10ms. */
  firstWindowMs?: number;
  /** Coalesce window for subsequent deltas. Default 100ms. */
  windowMs?: number;
}

const DELTA_TYPES = new Set(['message_delta', 'thought_delta']);

function isDelta(event: SessionEvent): boolean {
  return DELTA_TYPES.has(event.type);
}

/**
 * Coalesce streaming delta events into bounded batches — the downstream
 * push-half of the 10ms/100ms window scheme. Deltas arriving inside a
 * window are merged into one batch; non-delta events always flush pending
 * deltas first and are emitted as singletons (order preserved).
 *
 * Loss-free by construction: a background pump drains `source` into an
 * internal queue, so no event is ever abandoned to a lost race.
 */
export function batchEvents(
  source: AsyncIterable<SessionEvent>,
  options: BatchOptions = {}
): AsyncIterable<SessionEvent[]> {
  const queue = new EventQueue<SessionEvent>();
  void pump(source, queue);
  return batchFromQueue(queue, options);
}

async function pump(source: AsyncIterable<SessionEvent>, queue: EventQueue<SessionEvent>): Promise<void> {
  try {
    for await (const event of source) {
      queue.push(event);
    }
    queue.close();
  } catch (error) {
    queue.fail(error);
  }
}

async function* batchFromQueue(
  queue: EventQueue<SessionEvent>,
  options: BatchOptions
): AsyncGenerator<SessionEvent[]> {
  const firstWindowMs = options.firstWindowMs ?? 10;
  const windowMs = options.windowMs ?? 100;
  let pending: SessionEvent[] = [];

  while (true) {
    const head = await queue.next();
    if (head.done) return;
    if (!isDelta(head.value)) {
      yield [head.value];
      continue;
    }
    pending = [head.value];
    while (true) {
      const wait = pending.length === 1 ? firstWindowMs : windowMs;
      const result = await queue.nextWithTimeout(wait);
      if (result === 'timeout') {
        yield pending;
        pending = [];
        break;
      }
      if (result.done) {
        if (pending.length > 0) yield pending;
        return;
      }
      if (isDelta(result.value)) {
        pending.push(result.value);
        continue;
      }
      yield pending;
      pending = [];
      yield [result.value];
      break;
    }
  }
}
