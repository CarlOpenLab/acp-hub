import { AcpAgentAdapter } from 'acp-hub-core';
import type { AdapterOptions, AgentLaunchSpec } from 'acp-hub-core';

export interface CodexLaunchOptions {
  command?: string;
  args?: string[];
  /** Extra env merged over process.env, e.g. OPENAI_API_KEY. */
  env?: Record<string, string | undefined>;
  cwd?: string;
  client?: AdapterOptions;
}

/**
 * Lody's maintained ACP adapter for Codex (`npm i acp-extension-codex`).
 * It spawns `codex app-server` internally, so the Codex CLI must be
 * installed and authenticated on the host.
 *
 * Alternative: Zed's `codex-acp` npm package — swap command/args to use it.
 */
export const CODEX_ACP_DEFAULT = {
  command: 'npx',
  args: ['-y', 'acp-extension-codex'],
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

export * from 'acp-hub-core';
