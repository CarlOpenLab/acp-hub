import { AcpAgentAdapter } from '@cc-heart/acp-hub-core';
import type { AdapterOptions, AgentLaunchSpec } from '@cc-heart/acp-hub-core';

export interface CodexLaunchOptions {
  command?: string;
  args?: string[];
  /** Extra env merged over process.env, e.g. OPENAI_API_KEY. */
  env?: Record<string, string | undefined>;
  cwd?: string;
  client?: AdapterOptions;
}

/**
 * The official ACP adapter for Codex (`@agentclientprotocol/codex-acp`).
 * Maintained by the Agent Client Protocol project; formerly published as
 * `@zed-industries/codex-acp`, which is now deprecated. It wraps the Codex
 * CLI, so Codex must be installed and authenticated on the host (ChatGPT
 * subscription, CODEX_API_KEY, or OPENAI_API_KEY).
 */
export const CODEX_ACP_DEFAULT = {
  command: 'npx',
  args: ['-y', '@agentclientprotocol/codex-acp'],
} as const;

export function createCodexAdapter(options: CodexLaunchOptions = {}): AcpAgentAdapter {
  const launch: AgentLaunchSpec = {
    command: options.command ?? CODEX_ACP_DEFAULT.command,
    args: options.args ?? [...CODEX_ACP_DEFAULT.args],
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
  };
  return new AcpAgentAdapter('codex', launch, options.client);
}

export * from '@cc-heart/acp-hub-core';
