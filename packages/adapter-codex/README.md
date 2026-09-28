# @cc-heart/acp-hub-adapter-codex

[acp-hub](https://github.com/CarlOpenLab/acp-hub) 的 OpenAI Codex 适配器。

默认启动命令：

```
npx -y @agentclientprotocol/codex-acp
```

`@agentclientprotocol/codex-acp` 是 ACP 官方维护的 Codex ACP 服务器（Apache-2.0）。它包装 Codex CLI，所以**本机需要已安装并完成认证**（ChatGPT 登录、`CODEX_API_KEY` 或 `OPENAI_API_KEY` 三者之一）。

> 该包原名 `@zed-industries/codex-acp`，已在 npm 上标记废弃并迁移到 `@agentclientprotocol` 组织。

## 安装

```bash
npm install @cc-heart/acp-hub-adapter-codex
```

## 用法

```ts
import { createCodexAdapter } from '@cc-heart/acp-hub-adapter-codex';

const adapter = createCodexAdapter();
const session = await adapter.createSession({ cwd: process.cwd() });
console.log((await session.prompt('用一句话介绍你自己')).stopReason);
await adapter.dispose();
```

覆盖启动方式：

```ts
const adapter = createCodexAdapter({
  command: 'codex-acp',
  args: [],
  env: { CODEX_API_KEY: process.env.CODEX_API_KEY },
  client: { initializeTimeoutMs: 60_000 },
});
```

## 说明

- `agentId` 是 `'codex'`。
- 本包 re-export 了 `@cc-heart/acp-hub-core` 的全部内容，只装这一个包也能拿到 `AgentAdapter` 等核心类型。
- 未对真实 agent 做端到端实测：包名、bin、许可证已核实，真实握手尚未跑通验证。

## 许可

MIT