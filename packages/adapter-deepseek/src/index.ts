import { AcpAgentAdapter } from 'acp-hub-core';
import type { AdapterOptions, AgentLaunchSpec } from 'acp-hub-core';

export interface DeepSeekLaunchOptions {
  command?: string;
  args?: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
  client?: AdapterOptions;
}

/**
 * TODO(unverified): DeepSeek 官方目前没有稳定的公开 ACP 入口。
 * 参考路径：Lody 的 `packages/acp-extension-dsh`（源码在 D:/soft/Lody submodule）
 * 展示了如何包一层 DeepSeek Harness 的 ACP 插件；后续要么把那个包发布到 npm
 * 后直接用作 command，要么在本包里实现薄壳适配（core 的 harness 已够用）。
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

export * from 'acp-hub-core';
