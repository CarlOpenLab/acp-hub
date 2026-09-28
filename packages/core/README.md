# @cc-heart/acp-hub-core

把任意「会说 ACP 的 coding agent」统一成同一套类型化接口的传输层。

`acp-hub` 站在 ACP 的 **Client 端**：把 agent 当子进程启动，用 JSON-RPC over stdio 握手，再把 agent 的原生事件翻译成一条统一的 `SessionEvent` 异步流。下游只依赖 `AgentAdapter` / `AgentSession` / `SessionEvent`，**永远不按 agent 名字分支**。

- 协议：[ACP（Agent Client Protocol）](https://agentclientprotocol.com)
- 运行时依赖：`@agentclientprotocol/sdk`、`cross-spawn`
- Node >= 20，纯 ESM

接具体 agent 一般不需要直接装本包，装对应的适配器包即可：
`@cc-heart/acp-hub-adapter-claude` / `-codex` / `-pi` / `-deepseek`。

## 安装

```bash
npm install @cc-heart/acp-hub-core
```

## 用法

```ts
import { createAcpAgentAdapter } from '@cc-heart/acp-hub-core';

const adapter = createAcpAgentAdapter('my-agent', {
  command: 'my-agent',
  args: ['--acp'],
});

const capabilities = await adapter.connect();
console.log(capabilities.protocolVersion, capabilities.supportsLoad);

const session = await adapter.createSession({ cwd: process.cwd() });

// 先发 prompt（不要立刻 await），同时消费事件流
const turn = session.prompt('解释一下这个仓库');
turn.then(() => setTimeout(() => void session.dispose(), 100));

for await (const event of session.events) {
  switch (event.type) {
    case 'message_delta':
      process.stdout.write(event.text);
      break;
    case 'permission_request': {
      const allow = event.options.find((o) => o.kind === 'allow_once') ?? event.options[0];
      if (allow) await session.respondPermission(event.requestId, allow.optionId);
      else await session.cancelPermission(event.requestId);
      break;
    }
  }
}

console.log('turn finished:', (await turn).stopReason);
await adapter.dispose();
```

ACP 的语义有两点要注意：**一个 session 同时只能有一个进行中的 prompt**；`events` 是不会自己结束的流，`session.dispose()` 之后 `for await` 才会退出。

## API 概要

`AgentAdapter`

| 成员 | 说明 |
| --- | --- |
| `connect()` | 启动子进程并握手，幂等；返回 `AgentCapabilities` |
| `createSession({ cwd, mcpServers?, resumeSessionId?, meta? })` | 开新会话，或走 `session/load` 恢复 |
| `authenticate?(methodId)` | agent 广告了 auth methods 时可用 |
| `listSessions?(options)` | agent 广告 `listSessions` 时可用 |
| `dispose()` | 关闭连接并回收子进程 |

`AgentSession`

| 成员 | 说明 |
| --- | --- |
| `id` / `aliases` / `raw` | 会话 id、别名（agent 重分配 id 时）、原始 ACP 响应 |
| `events` | `AsyncIterable<SessionEvent>` |
| `prompt(input, { signal?, meta? })` | 发一个 turn，resolve 时该 turn 结束 |
| `interrupt()` | ACP `session/cancel` |
| `respondPermission()` / `cancelPermission()` | 应答 `permission_request` |
| `setMode?()` / `setConfigOption?()` | agent 广告了 modes / config options 时可用 |
| `dispose()` | 关闭会话与事件流 |

`SessionEvent` 的 `type` 取值：
`message_delta`、`thought_delta`、`tool_call`、`tool_call_update`、`plan`、`usage`、
`session_info`、`mode_update`、`commands_update`、`permission_request`、`agent_error`、`raw`。

失败统一抛 `AdapterError`，`code` 取值：
`agent_not_found`、`initialize_timeout`、`initialize_failed`、`connection_closed`、
`prompt_active`、`prompt_failed`、`permission_unknown`、`disposed`、`unsupported`、`unknown`。

## 设计约束

- 能用标准 ACP 信封的用标准；品牌私有语义放 `_meta`；消费者按 `event.type` 与能力字段分支，**不按 agent 名字分支**。
- `requestExtension(method, params)` 是通用逃生口，可发任意 `_brand/...` JSON-RPC。

## 许可

MIT