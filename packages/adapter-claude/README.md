# @cc-heart/acp-hub-adapter-claude

[acp-hub](https://github.com/CarlOpenLab/acp-hub) 的 Claude Code 适配器。

默认启动命令：

```
npx -y @agentclientprotocol/claude-agent-acp
```

`@agentclientprotocol/claude-agent-acp` 是 ACP 官方维护的 Claude Code ACP 服务器（Apache-2.0）。它包装 Claude Code CLI，所以**本机需要已安装并登录 Claude Code**。

> 该包原名 `@zed-industries/claude-code-acp`，已在 npm 上标记废弃并迁移到 `@agentclientprotocol` 组织。

## 安装

```bash
npm install @cc-heart/acp-hub-adapter-claude
```

## 用法

```ts
import { createClaudeAdapter } from '@cc-heart/acp-hub-adapter-claude';

const adapter = createClaudeAdapter();
const session = await adapter.createSession({ cwd: process.cwd() });
console.log((await session.prompt('用一句话介绍你自己')).stopReason);
await adapter.dispose();
```

覆盖启动方式（例如本机已全局安装，或需要注入 API key）：

```ts
const adapter = createClaudeAdapter({
  command: 'claude-agent-acp',
  args: [],
  env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
  client: { initializeTimeoutMs: 60_000 },
});
```

## 说明

- `agentId` 是 `'claude-code'`。
- 本包 re-export 了 `@cc-heart/acp-hub-core` 的全部内容，只装这一个包也能拿到 `AgentAdapter` 等核心类型。
- 未对真实 agent 做端到端实测：包名、bin、许可证已核实，真实握手尚未跑通验证。

## 许可

MIT