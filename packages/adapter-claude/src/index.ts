import { AcpAgentAdapter } from 'acp-hub-core';
import type { AdapterOptions, AgentLaunchSpec } from 'acp-hub-core';

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
 * Zed's official ACP adapter for Claude Code. Requires the Claude Code CLI
 * (`@anthropic-ai/claude-code`) to be installed and logged in on the host.
 *
 * Alternative: Lody's `acp-extension-claude` (npm) is a drop-in replacement —
 * swap `command`/`args` if you prefer its timeout/logging fixes.
 */
export const CLAUDE_CODE_ACP_DEFAULT = {
  command: 'npx',
  args: ['-y', '@zed-industries/claude-code-acp'],
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
export * from 'acp-hub-core';
