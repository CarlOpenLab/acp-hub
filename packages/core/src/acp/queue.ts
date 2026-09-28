/**
 * Minimal pushable async-iterable queue. Unbounded by design: the ACP harness
 * forwards agent events at wire speed and consumers apply their own batching:
 * the adapter stays ordered, the host batches.
 */
export class EventQueue<T> implements AsyncIterable<T> {
  #items: T[] = [];
  #waiters: {
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
    cancelled?: boolean;
  }[] = [];
  #ended = false;
  #error: { error: unknown } | null = null;

  push(item: T): void {
    if (this.#ended) return;
    let waiter = this.#waiters.shift();
    while (waiter && waiter.cancelled) {
      waiter = this.#waiters.shift();
    }
    if (waiter) waiter.resolve({ value: item, done: false });
    else this.#items.push(item);
  }

  /** Close the queue normally; iterators return. */
  close(): void {
    if (this.#ended) return;
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
  }

  /** Close the queue with an error; current and future iterators throw it. */
  fail(error: unknown): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#error = { error };
    for (const waiter of this.#waiters.splice(0)) {
      waiter.reject(error);
    }
    this.#items.length = 0;
  }

  /**
   * Wait for the next item indefinitely. Throws when the queue failed.
   */
  next(): Promise<IteratorResult<T>> {
    if (this.#items.length > 0) {
      return Promise.resolve({ value: this.#items.shift() as T, done: false });
    }
    if (this.#ended) {
      if (this.#error) return Promise.reject(this.#error.error);
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }

  /**
   * Wait for the next item, giving up after `timeoutMs`. On timeout the
   * reservation is cancelled so a later push() skips it — no events are
   * lost to the race. Throws when the queue failed.
   */
  nextWithTimeout(timeoutMs: number): Promise<IteratorResult<T> | 'timeout'> {
    if (this.#items.length > 0) {
      return Promise.resolve({ value: this.#items.shift() as T, done: false });
    }
    if (this.#ended) {
      if (this.#error) return Promise.reject(this.#error.error);
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise<IteratorResult<T> | 'timeout'>((resolve, reject) => {
      const waiter: {
        resolve: (result: IteratorResult<T>) => void;
        reject: (error: unknown) => void;
        cancelled?: boolean;
      } = { resolve, reject };
      this.#waiters.push(waiter);
      const timer = setTimeout(() => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        resolve('timeout');
      }, timeoutMs);
      if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    });
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      if (this.#items.length > 0) {
        yield this.#items.shift() as T;
        continue;
      }
      if (this.#ended) {
        if (this.#error) throw this.#error.error;
        return;
      }
      const result = await new Promise<IteratorResult<T>>((resolve, reject) => {
        this.#waiters.push({ resolve, reject });
      });
      if (result.done) {
        if (this.#error) throw this.#error.error;
        return;
      }
      yield result.value;
    }
  }
}
