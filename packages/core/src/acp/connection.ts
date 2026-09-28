import spawn from 'cross-spawn';
import type { ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import type {
  AdapterLogger,
  AdapterOptions,
  AgentLaunchSpec,
  CreateSessionOptions,
} from '../adapter.js';
import type { AgentCapabilities } from '../capabilities.js';
import type { AgentSessionSummary } from '../adapter.js';
import { AdapterError } from '../errors.js';
import type { ContentBlock } from '../events.js';
import { AcpSession } from './session.js';

const DEFAULT_CLIENT_INFO = { name: 'acp-hub', version: '0.1.0' } as const;

function toWebWritable(writable: Writable): WritableStream<Uint8Array> {
  // Swallow EPIPE: the agent process may exit while we still hold the pipe;
  // the connection itself will surface the closure.
  writable.on('error', () => {});
  return Writable.toWeb(writable) as unknown as WritableStream<Uint8Array>;
}

function toWebReadable(readable: Readable): ReadableStream<Uint8Array> {
  return Readable.toWeb(readable) as unknown as ReadableStream<Uint8Array>;
}

function toCapabilities(init: acp.InitializeResponse): AgentCapabilities {
  return {
    raw: init,
    protocolVersion: init.protocolVersion,
    authMethods: init.authMethods ?? [],
    supportsLoad: init.agentCapabilities?.loadSession === true,
  };
}

/**
 * Owns one agent subprocess and the ACP connection to it. Multiple sessions
 * multiplex over a single connection.
 */
export class AcpAgentConnection {
  readonly #spec: AgentLaunchSpec;
  readonly #options: AdapterOptions;
  readonly #log: AdapterLogger;
  readonly #sessions = new Map<string, AcpSession>();
  readonly #clientHandler: acp.Client;
  #process?: ChildProcess;
  #connection?: acp.ClientSideConnection;
  #initResponse?: acp.InitializeResponse;
  #closed = false;
  /** Rejects while the process dies before/during initialize; no-op afterwards. */
  #deathDuringInit?: { promise: Promise<never>; reject: (error: unknown) => void };

  constructor(spec: AgentLaunchSpec, options: AdapterOptions = {}) {
    this.#spec = spec;
    this.#options = options;
    this.#log = options.logger ?? (() => {});

    this.#clientHandler = {
      sessionUpdate: async (params: acp.SessionNotification): Promise<void> => {
        const session = this.#sessions.get(params.sessionId);
        if (session) {
          session.handleNotification(params);
          return;
        }
        // 路由恢复：有的 agent（实测 oh-my-pi）在 session/load 一个不认识的
        // 会话 id 时不报错，而是新建内部会话、用另一个 id 推 update。此时把
        // update 认领给「唯一的、尚未收到任何通知的 resume 会话」。
        const candidates = [...this.#sessions.values()].filter(
          (item) => item.adoptable && !item.receivedUpdate
        );
        const adopted = candidates.length === 1 ? candidates[0] : undefined;
        if (adopted) {
          adopted.adoptAlias(params.sessionId);
          this.#sessions.set(params.sessionId, adopted);
          this.#log(
            'info',
            `sessionUpdate for unknown session ${params.sessionId} — adopted as alias of ${adopted.id} (resume reassignment)`
          );
          adopted.handleNotification(params);
          return;
        }
        this.#log('debug', `sessionUpdate for unknown session ${params.sessionId} — dropped`);
      },
      requestPermission: async (
        params: acp.RequestPermissionRequest
      ): Promise<acp.RequestPermissionResponse> => {
        // 命中主 id 或已认领的别名均可
        const session =
          this.#sessions.get(params.sessionId) ??
          [...this.#sessions.values()].find((item) => item.aliases.has(params.sessionId));
        if (!session) return { outcome: { outcome: 'cancelled' } };
        return session.handlePermissionRequest(params);
      },
    };
  }

  get isConnected(): boolean {
    return this.#connection !== undefined && this.#initResponse !== undefined && !this.#closed;
  }

  /** Escape hatch for extension methods (`_brand/...` JSON-RPC). */
  get rawConnection(): acp.ClientSideConnection | undefined {
    return this.#connection;
  }

  async connect(): Promise<AgentCapabilities> {
    if (this.isConnected && this.#initResponse) return toCapabilities(this.#initResponse);
    if (this.#closed) throw new AdapterError('disposed', 'Connection already disposed');

    const child = spawn(this.#spec.command, this.#spec.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.#spec.env },
      ...(this.#spec.cwd !== undefined ? { cwd: this.#spec.cwd } : {}),
      windowsHide: true,
    });
    this.#process = child;

    let rejectDeathDuringInit: ((error: unknown) => void) | undefined;
    const deathDuringInit = new Promise<never>((_, reject) => {
      rejectDeathDuringInit = reject;
    });
    deathDuringInit.catch(() => {}); // unhandled-rejection guard, same pattern as sessions
    this.#deathDuringInit = { promise: deathDuringInit, reject: rejectDeathDuringInit! };

    child.on('error', (err: NodeJS.ErrnoException) => {
      const code = err.code === 'ENOENT' ? 'agent_not_found' : 'initialize_failed';
      const error = new AdapterError(
        code,
        `Failed to launch agent process "${this.#spec.command}": ${err.message}`,
        { cause: err }
      );
      this.#log('error', error.message);
      if (!this.#initResponse) rejectDeathDuringInit?.(error);
      this.#handleDeath(error);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trimEnd();
      if (text.length > 0) this.#log('debug', `[${this.#spec.command} stderr] ${text}`);
    });

    child.on('exit', (code, signal) => {
      this.#log('info', `agent process exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
      const error = new AdapterError(
        'connection_closed',
        `Agent process exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`
      );
      if (!this.#initResponse) rejectDeathDuringInit?.(error);
      this.#handleDeath(error);
    });

    if (!child.stdin || !child.stdout) {
      this.#closed = true;
      throw new AdapterError('initialize_failed', 'Agent subprocess stdio pipes unavailable');
    }

    const stream = acp.ndJsonStream(toWebWritable(child.stdin), toWebReadable(child.stdout));
    const connection = new acp.ClientSideConnection(() => this.#clientHandler, stream);
    this.#connection = connection;

    const timeoutMs = this.#options.initializeTimeoutMs ?? 30_000;
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new AdapterError(
              'initialize_timeout',
              `Agent did not complete initialize within ${timeoutMs}ms`,
              { detail: { command: this.#spec.command } }
            )
          ),
        timeoutMs
      );
    });
    timeoutPromise.catch(() => {});

    try {
      const init = await Promise.race([
        connection.initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            ...this.#options.clientCapabilities,
          },
          clientInfo: this.#options.clientInfo ?? { ...DEFAULT_CLIENT_INFO },
        }),
        deathDuringInit,
        timeoutPromise,
      ]);
      this.#initResponse = init;
      return toCapabilities(init);
    } catch (error) {
      this.#closed = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already dead */
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      this.#deathDuringInit = undefined;
    }
  }

  async createSession(options: CreateSessionOptions): Promise<AcpSession> {
    const connection = this.#connection;
    if (!connection || !this.#initResponse) {
      throw new AdapterError('unknown', 'connect() must complete before createSession()');
    }
    const mcpServers = options.mcpServers ?? [];
    const meta = options.meta;
    const newSessionMeta = meta as acp.NewSessionRequest['_meta'];
    const response: acp.NewSessionResponse | acp.LoadSessionResponse = options.resumeSessionId
      ? await connection.loadSession({
          cwd: options.cwd,
          mcpServers,
          sessionId: options.resumeSessionId,
          ...(meta ? { _meta: newSessionMeta } : {}),
        })
      : await connection.newSession({
          cwd: options.cwd,
          mcpServers,
          ...(meta ? { _meta: newSessionMeta } : {}),
        });
    const sessionId = options.resumeSessionId ?? (response as acp.NewSessionResponse).sessionId;
    const session = new AcpSession(sessionId, response, this, {
      adoptable: Boolean(options.resumeSessionId),
    });
    this.#sessions.set(session.id, session);
    return session;
  }

  async prompt(
    sessionId: string,
    blocks: ContentBlock[],
    meta?: Record<string, unknown>
  ): Promise<acp.PromptResponse> {
    const connection = this.#connection;
    if (!connection) throw new AdapterError('connection_closed', 'Agent connection is not open');
    const promptMeta = meta as acp.PromptRequest['_meta'];
    return connection.prompt({
      sessionId,
      prompt: blocks,
      ...(promptMeta ? { _meta: promptMeta } : {}),
    });
  }

  async cancel(sessionId: string): Promise<void> {
    await this.#connection?.cancel({ sessionId });
  }

  async setSessionMode(sessionId: string, modeId: string): Promise<void> {
    await this.#connection?.setSessionMode({ sessionId, modeId });
  }

  /** ACP `session/set_config_option` — e.g. switching the selected model. */
  async setSessionConfigOption(
    params: acp.SetSessionConfigOptionRequest
  ): Promise<acp.SetSessionConfigOptionResponse> {
    const connection = this.#connection;
    if (!connection) throw new AdapterError('connection_closed', 'Agent connection is not open');
    return connection.setSessionConfigOption(params);
  }

  async authenticate(methodId: string): Promise<void> {
    await this.#connection?.authenticate({ methodId });
  }

  /** Generic extension request (`_brand/...` JSON-RPC) escape hatch. */
  async requestExtension<Response = unknown, Params = unknown>(
    method: string,
    params?: Params
  ): Promise<Response> {
    const connection = this.#connection;
    if (!connection) throw new AdapterError('connection_closed', 'Agent connection is not open');
    return connection.request<Response, Params>(method, params);
  }

  /** ACP `session/list` — only when the agent advertises the capability. */
  async listSessions(options?: { cwd?: string }): Promise<AgentSessionSummary[]> {
    const connection = this.#connection;
    if (!connection) throw new AdapterError('connection_closed', 'Agent connection is not open');
    const response = await connection.listSessions({
      ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
    });
    return ((response as unknown as { sessions?: unknown[] }).sessions ?? []).map((entry) => {
      const record = entry as unknown as Record<string, unknown>;
      return {
        sessionId: String(record.sessionId),
        ...(typeof record.cwd === 'string' ? { cwd: record.cwd } : {}),
        ...(typeof record.title === 'string' ? { title: record.title } : {}),
        ...(typeof record.updatedAt === 'string' ? { updatedAt: record.updatedAt } : {}),
      };
    });
  }

  onSessionDisposed(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }

  async dispose(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const session of [...this.#sessions.values()]) {
      await session.dispose();
    }
    const child = this.#process;
    this.#process = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.once('exit', finish);
      try {
        child.kill('SIGTERM');
      } catch {
        finish();
      }
      const graceMs = this.#options.killGraceMs ?? 5_000;
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already dead */
        }
      }, graceMs).unref?.();
      setTimeout(finish, graceMs + 1_000).unref?.();
    });
  }

  #handleDeath(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const session of [...this.#sessions.values()]) {
      session.handleClosed(error);
    }
    this.#sessions.clear();
  }
}
