import { randomUUID } from 'node:crypto';
import type {
  ContentBlock,
  LoadSessionResponse,
  NewSessionResponse,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import type { AgentSession, PromptOptions } from '../adapter.js';
import { AdapterError } from '../errors.js';
import type { PromptInput, SessionEvent, SteerResult, TurnResult } from '../events.js';
import type { AcpAgentConnection } from './connection.js';
import { EventQueue } from './queue.js';
import { mapAcpToolCall, translateNotification } from './translate.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function abortError(): Error {
  return new AdapterError('prompt_failed', 'Prompt aborted', {
    cause: new DOMException('The operation was aborted', 'AbortError'),
  });
}

export class AcpSession implements AgentSession {
  readonly id: string;
  readonly raw: NewSessionResponse | LoadSessionResponse;
  readonly events: AsyncIterable<SessionEvent>;

  readonly #connection: AcpAgentConnection;
  readonly #steeringMethod?: string;
  readonly #queue = new EventQueue<SessionEvent>();
  readonly #permissionWaiters = new Map<string, Deferred<RequestPermissionResponse>>();
  #activePrompt = false;
  #closed = false;
  #rejectClosed!: (error: unknown) => void;
  readonly #closedPromise: Promise<never>;

  constructor(
    id: string,
    raw: NewSessionResponse | LoadSessionResponse,
    connection: AcpAgentConnection,
    options: { steeringMethod?: string } = {}
  ) {
    this.id = id;
    this.raw = raw;
    this.#connection = connection;
    this.#steeringMethod = options.steeringMethod;
    this.events = this.#queue;
    let rejectClosed!: (error: unknown) => void;
    this.#closedPromise = new Promise<never>((_, reject) => {
      rejectClosed = reject;
    });
    // Unhandled-rejection guard: #closedPromise is only raced while a prompt
    // is in flight, but it may be rejected by dispose() at any time.
    this.#closedPromise.catch(() => {});
    this.#rejectClosed = rejectClosed;
  }

  emit(event: SessionEvent): void {
    this.#queue.push(event);
  }

  handleNotification(notification: SessionNotification): void {
    if (notification.sessionId !== this.id) return;
    const event = translateNotification(notification);
    if (event) this.emit(event);
  }

  async handlePermissionRequest(
    params: RequestPermissionRequest
  ): Promise<RequestPermissionResponse> {
    const requestId = randomUUID();
    const deferred = createDeferred<RequestPermissionResponse>();
    this.#permissionWaiters.set(requestId, deferred);
    try {
      this.emit({
        type: 'permission_request',
        requestId,
        toolCall: mapAcpToolCall(params.toolCall),
        options: params.options.map((option) => ({
          optionId: option.optionId,
          name: option.name,
          kind: option.kind,
          ...(option._meta !== undefined
            ? { meta: option._meta as Record<string, unknown> }
            : {}),
        })),
        ...(params._meta !== undefined
          ? { meta: params._meta as Record<string, unknown> }
          : {}),
      });
      return await deferred.promise;
    } finally {
      this.#permissionWaiters.delete(requestId);
    }
  }

  async prompt(input: PromptInput, options: PromptOptions = {}): Promise<TurnResult> {
    if (this.#closed) throw new AdapterError('disposed', 'Session is closed');
    if (this.#activePrompt) {
      throw new AdapterError(
        'prompt_active',
        'A prompt is already in flight on this session. Call interrupt() first (steering support is on the roadmap).'
      );
    }
    const blocks: ContentBlock[] =
      typeof input === 'string' ? [{ type: 'text', text: input }] : input;
    this.#activePrompt = true;
    const abortSignal = options.signal;
    try {
      if (abortSignal?.aborted) throw abortError();
      const promptPromise = this.#connection.prompt(this.id, blocks, options.meta);
      const raced = abortSignal
        ? Promise.race([
            promptPromise,
            this.#closedPromise,
            new Promise<never>((_, reject) => {
              abortSignal.addEventListener(
                'abort',
                () => {
                  void this.#connection.cancel(this.id).catch(() => {});
                  reject(abortError());
                },
                { once: true }
              );
            }),
          ])
        : Promise.race([promptPromise, this.#closedPromise]);
      const response: PromptResponse = await raced;
      return { stopReason: response.stopReason };
    } finally {
      this.#activePrompt = false;
    }
  }

  async interrupt(): Promise<void> {
    await this.#connection.cancel(this.id);
  }

  async steer(input: PromptInput, options: PromptOptions = {}): Promise<SteerResult> {
    if (this.#closed) throw new AdapterError('disposed', 'Session is closed');
    if (!this.#steeringMethod) {
      throw new AdapterError(
        'unsupported',
        'Agent does not advertise request-transport steering (agentCapabilities._meta.lody.steering or _meta.hub.steering)'
      );
    }
    if (this.#activePrompt === false) {
      throw new AdapterError('prompt_failed', 'Steering requires an active prompt on this session');
    }
    void options;
    const blocks: ContentBlock[] =
      typeof input === 'string' ? [{ type: 'text', text: input }] : input;
    const steerId = randomUUID();
    const response = await this.#connection.requestExtension<{
      outcome: 'injected' | 'failed';
    }, { sessionId: string; prompt: ContentBlock[]; steerId: string }>(this.#steeringMethod, {
      sessionId: this.id,
      prompt: blocks,
      steerId,
    });
    return { accepted: response?.outcome === 'injected', steerId };
  }

  async respondPermission(requestId: string, optionId: string): Promise<void> {
    const waiter = this.#permissionWaiters.get(requestId);
    if (!waiter) {
      throw new AdapterError('permission_unknown', `Unknown permission requestId: ${requestId}`);
    }
    waiter.resolve({ outcome: { outcome: 'selected', optionId } });
  }

  async cancelPermission(requestId: string): Promise<void> {
    const waiter = this.#permissionWaiters.get(requestId);
    if (!waiter) {
      throw new AdapterError('permission_unknown', `Unknown permission requestId: ${requestId}`);
    }
    waiter.resolve({ outcome: { outcome: 'cancelled' } });
  }

  async setMode(modeId: string): Promise<void> {
    await this.#connection.setSessionMode(this.id, modeId);
  }

  async dispose(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#permissionWaiters.values()) {
      waiter.resolve({ outcome: { outcome: 'cancelled' } });
    }
    this.#permissionWaiters.clear();
    this.#rejectClosed(new AdapterError('disposed', 'Session disposed'));
    this.#queue.close();
    this.#connection.onSessionDisposed(this.id);
  }

  /** Abnormal termination (agent process died). Fail, don't close. */
  handleClosed(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#permissionWaiters.values()) {
      waiter.reject(error);
    }
    this.#permissionWaiters.clear();
    this.#rejectClosed(error);
    this.#queue.fail(error);
  }
}
