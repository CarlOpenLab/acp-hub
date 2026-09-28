/**
 * ACP → unified event translation. Pure functions, no state — tool-call
 * dedup/state machines belong to a future adapter-level concern, not here.
 */
import type {
  ContentBlock,
  RequestPermissionRequest,
  SessionNotification,
  ToolCall as AcpToolCall,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk';
import type { PermissionOption, SessionEvent, ToolCall } from '../events.js';

type AcpUpdate = SessionNotification['update'];

export function extractTextBlock(block: ContentBlock): string | null {
  return block.type === 'text' ? block.text : null;
}

export function mapAcpToolCall(toolCall: AcpToolCall | ToolCallUpdate): ToolCall {
  const status = ('status' in toolCall ? toolCall.status : undefined) ?? 'in_progress';
  return {
    toolCallId: toolCall.toolCallId,
    status,
    ...(toolCall.kind != null ? { kind: toolCall.kind } : {}),
    ...(toolCall.title != null ? { title: toolCall.title } : {}),
    ...('rawInput' in toolCall && toolCall.rawInput != null
      ? { rawInput: toolCall.rawInput }
      : {}),
    ...('rawOutput' in toolCall && toolCall.rawOutput != null
      ? { rawOutput: toolCall.rawOutput }
      : {}),
    ...('content' in toolCall && toolCall.content != null ? { content: toolCall.content } : {}),
    ...('locations' in toolCall && toolCall.locations != null
      ? { locations: toolCall.locations }
      : {}),
  };
}

export function mapPermissionOptions(
  options: RequestPermissionRequest['options']
): PermissionOption[] {
  return options.map((option) => ({
    optionId: option.optionId,
    name: option.name,
    kind: option.kind,
    ...(option._meta !== undefined ? { meta: option._meta as Record<string, unknown> } : {}),
  }));
}

/** Translate one ACP session update into zero or one unified event. */
export function translateNotification(notification: SessionNotification): SessionEvent | null {
  const update = notification.update;
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const text = extractTextBlock(update.content);
      return text !== null ? { type: 'message_delta', text } : { type: 'raw', update };
    }
    case 'agent_thought_chunk': {
      const text = extractTextBlock(update.content);
      return text !== null ? { type: 'thought_delta', text } : { type: 'raw', update };
    }
    case 'tool_call':
      return { type: 'tool_call', toolCall: mapAcpToolCall(update) };
    case 'tool_call_update':
      return { type: 'tool_call_update', toolCall: mapAcpToolCall(update) };
    case 'plan':
      return { type: 'plan', entries: update.entries };
    case 'current_mode_update':
      return { type: 'mode_update', currentModeId: update.currentModeId };
    case 'user_message_chunk':
      // Echo of our own prompt, not an agent event, so it is dropped.
      return null;
    default: {
      // Newer ACP updates that older SDK typings may not cover as literals.
      const kind = update.sessionUpdate as string;
      const raw = update as unknown as Record<string, unknown>;
      if (kind === 'available_commands_update') {
        const update = raw as unknown as {
          availableCommands?: { name?: string; description?: string | null }[];
        };
        const commands = (update.availableCommands ?? [])
          .filter((command) => typeof command?.name === 'string')
          .map((command) => ({
            name: command.name as string,
            ...(command.description != null ? { description: command.description } : {}),
          }));
        return { type: 'commands_update', commands };
      }
      if (kind === 'session_info_update') {
        const info = update as unknown as { sessionInfo?: { title?: string } };
        return {
          type: 'session_info',
          ...(info.sessionInfo?.title !== undefined ? { title: info.sessionInfo.title } : {}),
          meta: update as unknown as Record<string, unknown>,
        };
      }
      if (kind === 'usage_update') {
        const usage = update as unknown as {
          used?: number;
          size?: number;
          cost?: { amount?: number; currency?: string };
        };
        return {
          type: 'usage',
          usage: {
            ...(usage.cost?.amount !== undefined
              ? { costUsd: usage.cost.currency === 'USD' ? usage.cost.amount : undefined }
              : {}),
            ...(usage.used !== undefined && usage.size !== undefined
              ? { contextWindow: { used: usage.used, total: usage.size } }
              : {}),
            meta: update as unknown as Record<string, unknown>,
          },
        };
      }
      return { type: 'raw', update };
    }
  }
}
