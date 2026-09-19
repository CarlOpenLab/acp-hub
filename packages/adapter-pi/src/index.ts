import { AcpAgentAdapter } from 'acp-hub-core';
import type { AdapterOptions, AgentLaunchSpec } from 'acp-hub-core';

export interface PiLaunchOptions {
  command?: string;
  args?: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
  client?: AdapterOptions;
}

/**
 * pi 家族的 ACP 启动预设（2026-09-19 实测确认，open-chat 集成验证）：
 * - Pi (badlogic/pi-mono)：本地 `pi --mode acp`（stdio JSONL ACP）。
 *   注意 npm 上 @mariozechner/pi 是无关的 vLLM 工具包，不是本 Pi；
 *   @earendil-works/pi 尚未发布，因此不走 npx，要求本地安装 CLI。
 * - Oh My Pi (omp)：本地 `omp acp` 子命令（v18+，stdio ACP，initialize
 *   握手返回 agentInfo.name = "oh-my-pi"）。
 *   注意 oh-my-pi npm 包是 pi 的扩展（dist/extension.js），其 bin 是未编译
 *   的 TS 诊断脚本，不能作为 ACP 服务启动。
 */
export const PI_ACP_DEFAULT = {
  command: 'pi',
  args: ['--mode', 'acp'],
} as const;

export const OH_MY_PI_ACP_DEFAULT = {
  command: 'omp',
  args: ['acp'],
} as const;

export function createPiAdapter(options: PiLaunchOptions = {}): AcpAgentAdapter {
  return createPiFamilyAdapter('pi', PI_ACP_DEFAULT, options);
}

export function createOhMyPiAdapter(options: PiLaunchOptions = {}): AcpAgentAdapter {
  return createPiFamilyAdapter('oh-my-pi', OH_MY_PI_ACP_DEFAULT, options);
}

function createPiFamilyAdapter(
  agentId: string,
  defaults: { command: string; readonly args: readonly string[] },
  options: PiLaunchOptions
): AcpAgentAdapter {
  const launch: AgentLaunchSpec = {
    command: options.command ?? defaults.command,
    args: options.args ?? [...defaults.args],
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
  };
  return new AcpAgentAdapter(agentId, launch, options.client);
}

export * from 'acp-hub-core';
