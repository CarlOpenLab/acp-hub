import { AcpAgentAdapter } from '@cc-heart/acp-hub-core';
import type { AdapterOptions, AgentLaunchSpec } from '@cc-heart/acp-hub-core';

export interface ClaudeLaunchOptions {
  /**
   * Override the launch command (default: npx). On machines where the
   * adapter is installed globally, pass e.g. 'claude-code-acp'.
   */
  command?: string;
  args?: string[];
  /** Extra env merged over process.env, e.g. ANTHROPIC_API_KEY. */
  env?: Record<string, string | undefined>;
  cwd?: string;
  /** Adapter-level options (client info, timeouts, logger). */
  client?: AdapterOptions;
}

/**
 * The official ACP adapter for Claude Code (`@agentclientprotocol/claude-agent-acp`).
 * Maintained by the Agent Client Protocol project; formerly published as
 * `@zed-industries/claude-code-acp`, which is now deprecated. Requires the
 * Claude Code CLI to be installed and logged in on the host.
 */
export const CLAUDE_CODE_ACP_DEFAULT = {
  command: 'npx',
  args: ['-y', '@agentclientprotocol/claude-agent-acp'],
} as const;

export function createClaudeAdapter(options: ClaudeLaunchOptions = {}): AcpAgentAdapter {
  const launch: AgentLaunchSpec = {
    command: options.command ?? CLAUDE_CODE_ACP_DEFAULT.command,
    args: options.args ?? [...CLAUDE_CODE_ACP_DEFAULT.args],
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
  };
  return new AcpAgentAdapter('claude-code', launch, options.client);
}

// Downstream can import the full type surface from the adapter package alone.
export * from '@cc-heart/acp-hub-core';
