import type { LoadSessionResponse, McpServer, NewSessionResponse } from '@agentclientprotocol/sdk';
import type { AgentCapabilities } from './capabilities.js';
import type {
  ElicitationResponse,
  PromptInput,
  SessionEvent,
  SteerResult,
  TurnResult,
} from './events.js';

/** How to launch an agent subprocess speaking ACP over stdio. */
export interface AgentLaunchSpec {
  command: string;
  args?: string[];
  /** Merged over `process.env` inside the spawned process. */
  env?: Record<string, string | undefined>;
  cwd?: string;
}

export type AdapterLogLevel = 'debug' | 'info' | 'warn' | 'error';
export type AdapterLogger = (level: AdapterLogLevel, message: string, extra?: unknown) => void;

export interface AdapterOptions {
  clientInfo?: { name: string; version: string };
  /** Default 30s. */
  initializeTimeoutMs?: number;
  /** SIGTERM → SIGKILL grace when disposing. Default 5s. */
  killGraceMs?: number;
  logger?: AdapterLogger;
}

export interface CreateSessionOptions {
  cwd: string;
  mcpServers?: McpServer[];
  /** Resume an existing conversation (ACP `session/load`). */
  resumeSessionId?: string;
  /** Sent as `_meta` on `session/new` / `session/load` — brand extension hooks live here. */
  meta?: Record<string, unknown>;
}

export interface PromptOptions {
  signal?: AbortSignal;
  /** Sent as `_meta` on `session/prompt` — e.g. goal control or steering metadata. */
  meta?: Record<string, unknown>;
}

/**
 * One conversation with one agent. Events stream through `events` while
 * `prompt()` resolves when the turn ends (ACP semantics: one active prompt
 * per session; steering arrives as an explicit feature later).
 */
export interface AgentSession {
  readonly id: string;
  /** Raw ACP session response (modes, models, config options, `_meta`). */
  readonly raw: NewSessionResponse | LoadSessionResponse;
  readonly events: AsyncIterable<SessionEvent>;
  prompt(input: PromptInput, options?: PromptOptions): Promise<TurnResult>;
  /** Interrupt the active turn (ACP `session/cancel`). */
  interrupt(): Promise<void>;
  /** Answer a `permission_request` event. */
  respondPermission(requestId: string, optionId: string): Promise<void>;
  cancelPermission(requestId: string): Promise<void>;
  respondElicitation?(requestId: string, response: ElicitationResponse): Promise<void>;
  /** Switch session mode (e.g. plan mode) when the agent advertises modes. */
  setMode?(modeId: string): Promise<void>;
  /**
   * Inject an interjection into the active turn. Only available when the
   * agent advertises request-transport steering (`_meta.lody.steering` or
   * `_meta.hub.steering`); throws AdapterError('unsupported') otherwise.
   */
  steer?(input: PromptInput, options?: PromptOptions): Promise<SteerResult>;
  /** Close this session and its event stream. The underlying connection stays usable. */
  dispose(): Promise<void>;
}

/** Loose summary of an agent-side session, from ACP `session/list`. */
export interface AgentSessionSummary {
  sessionId: string;
  cwd?: string;
  title?: string;
  updatedAt?: string;
}

/**
 * The unified adapter surface every per-agent package exposes. Downstream
 * code depends on this interface only; the concrete adapter decides how the
 * native agent is launched and translated.
 */
export interface AgentAdapter {
  readonly agentId: string;
  /** Spawn the agent process and run the ACP handshake. Idempotent. */
  connect(): Promise<AgentCapabilities>;
  createSession(options: CreateSessionOptions): Promise<AgentSession>;
  authenticate?(methodId: string): Promise<void>;
  /** List sessions known to the agent (only when it advertises `listSessions`). */
  listSessions?(options?: { cwd?: string }): Promise<AgentSessionSummary[]>;
  dispose(): Promise<void>;
}
