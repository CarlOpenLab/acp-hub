import { AcpAgentAdapter } from '@cc-heart/acp-hub-core';
import type { AdapterOptions, AgentLaunchSpec } from '@cc-heart/acp-hub-core';

export interface DeepSeekLaunchOptions {
  command?: string;
  args?: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
  client?: AdapterOptions;
}

/**
 * TODO(unverified): DeepSeek 官方目前没有稳定的公开 ACP 入口。
 * 接入路径：先用 ACP 薄壳包一层 DeepSeek 的工具（core 的 harness 已够用），
 * 发布后可直接用作 command，或在本包里实现适配。
 * 接入时只需确认启动命令并填进 DEEPSEEK_ACP_DEFAULT。
 */
export const DEEPSEEK_ACP_DEFAULT = {
  command: 'deepseek-harness-acp',
  args: [] as string[],
} as const;

/** EXPERIMENTAL: launch spec unverified until a public ACP entry exists. */
export function createDeepSeekAdapter(options: DeepSeekLaunchOptions = {}): AcpAgentAdapter {
  const launch: AgentLaunchSpec = {
    command: options.command ?? DEEPSEEK_ACP_DEFAULT.command,
    args: options.args ?? [...DEEPSEEK_ACP_DEFAULT.args],
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
  };
  return new AcpAgentAdapter('deepseek', launch, options.client);
}

export * from '@cc-heart/acp-hub-core';
