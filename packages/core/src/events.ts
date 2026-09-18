/**
 * Unified session event model.
 *
 * Every adapter translates its native protocol (or ACP) into these events.
 * Downstream consumers branch on `SessionEvent.type` only — never on the
 * agent's identity. This mirrors Lody's contract discipline: standard ACP
 * envelopes first, `_meta` extensions second, custom methods last.
 */
import type {
  ContentBlock,
  McpServer,
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
} from '@agentclientprotocol/sdk';

// Re-exported so downstream consumers can build prompt/tool payloads without
// depending on the ACP SDK directly.
export type { ContentBlock, McpServer, ToolCallContent, ToolCallLocation, ToolKind };

/** Prompt input: a plain string is shorthand for a single text block. */
export type PromptInput = string | ContentBlock[];

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/** Canonical tool call snapshot. `tool_call` and `tool_call_update` share this shape. */
export interface ToolCall {
  toolCallId: string;
  status: ToolCallStatus;
  kind?: ToolKind;
  title?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
}

export interface PlanEntry {
  content: string;
  priority: 'high' | 'medium' | 'low';
  status: 'pending' | 'in_progress' | 'completed';
}

/**
 * Cross-provider usage snapshot. All token buckets are disjoint; a missing
 * cost means unknown, not free (same rule as Lody's usage contract).
 */
export interface UsageSummary {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  /** USD; may be an adapter-documented estimate. */
  costUsd?: number;
  contextWindow?: { used: number; total: number };
  meta?: Record<string, unknown>;
}

export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

export interface TurnResult {
  stopReason: StopReason;
  usage?: UsageSummary;
}

export interface PermissionOption {
  optionId: string;
  name: string;
  /** ACP kinds: allow_once | allow_always | reject_once | reject_always (agents may extend). */
  kind: string;
  meta?: Record<string, unknown>;
}

/** Reserved for `elicitation/create` bridging (roadmap; not wired in 0.1). */
export interface ElicitationResponse {
  action: 'confirm' | 'cancel' | 'decline';
  content?: Record<string, unknown>;
}

export interface SessionModeInfo {
  id: string;
  name: string;
  description?: string;
}

export interface AvailableCommand {
  name: string;
  description?: string;
}

/** Result of `session.steer()` — an interjection into the active turn. */
export interface SteerResult {
  accepted: boolean;
  steerId: string;
  detail?: unknown;
}

/**
 * The single event stream every session produces, regardless of agent.
 * `raw` is the escape hatch: untranslated ACP updates pass through so
 * consumers are never blocked on a missing translation here.
 */
export type SessionEvent =
  | { type: 'message_delta'; text: string; meta?: Record<string, unknown> }
  | { type: 'thought_delta'; text: string; meta?: Record<string, unknown> }
  | { type: 'tool_call'; toolCall: ToolCall }
  | { type: 'tool_call_update'; toolCall: ToolCall }
  | { type: 'plan'; entries: PlanEntry[] }
  | { type: 'usage'; usage: UsageSummary }
  | { type: 'session_info'; title?: string; meta?: Record<string, unknown> }
  | {
      type: 'mode_update';
      currentModeId: string;
      availableModes?: SessionModeInfo[];
    }
  | { type: 'commands_update'; commands: AvailableCommand[] }
  | {
      type: 'permission_request';
      requestId: string;
      toolCall?: ToolCall;
      options: PermissionOption[];
      meta?: Record<string, unknown>;
    }
  | { type: 'agent_error'; message: string; code?: string; meta?: Record<string, unknown> }
  | { type: 'raw'; update: unknown };
