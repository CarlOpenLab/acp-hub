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
 * TODO(unverified): pi 的 ACP 启动参数需要实测确认。
 * pi (badlogic/pi-mono) 提供 ACP 运行模式；Oh My Pi (omp) 是其社区分支，
 * 两者共享同一套 ACP 语义，本包用不同的 launch 预设覆盖。
 * 首次接入时：装好 pi / omp，跑 `examples/quickstart` 验证，按需修正 args。
 */
export const PI_ACP_DEFAULT = {
  command: 'npx',
  args: ['-y', '@mariozechner/pi', '--mode', 'acp'],
} as const;

export const OH_MY_PI_ACP_DEFAULT = {
  command: 'npx',
  args: ['-y', 'oh-my-pi', '--mode', 'acp'],
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
