# @cc-heart/acp-hub-gateway

把 [acp-hub](https://github.com/CarlOpenLab/acp-hub) 的适配器暴露成 HTTP + SSE，任何语言的下游都能接。

- 事件按 10ms / 100ms 双窗口合批下发
- 每帧带单调递增 `seq`，`?lastSeq=N` 支持断线重放与多端收敛
- 权限请求可以交给下游应答（`manual`），也可以由网关自动放行（`allow-once`）

## 安装

```bash
npm install @cc-heart/acp-hub-gateway
```

## 用法

```ts
import { createGatewayServer } from '@cc-heart/acp-hub-gateway';

const gateway = createGatewayServer({
  agents: {
    codex: {
      launch: { command: 'npx', args: ['-y', '@agentclientprotocol/codex-acp'] },
      permissionPolicy: 'manual',
    },
  },
});

const port = await gateway.listen(3333);
console.log('gateway on', port);
```

## 路由

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| POST | `/api/agents/:agentId/sessions` | body `{ cwd }` → `{ sessionId }` |
| GET | `/api/sessions/:id` | 会话快照 |
| GET | `/api/sessions/:id/events?lastSeq=N` | **SSE** 事件流 |
| POST | `/api/sessions/:id/prompt` | body `{ text }` |
| POST | `/api/sessions/:id/permission` | body `{ requestId, optionId }` |
| POST | `/api/sessions/:id/interrupt` | 中断当前 turn |
| DELETE | `/api/sessions/:id` | 关闭会话 |

SSE 帧格式是 `id: <seq>` 加 `data: {"kind":...,"seq":...}`，`kind` 取值：
`hello` / `events` / `turn_completed` / `closed` / `error`。

### 例子

```bash
curl -X POST http://127.0.0.1:3333/api/agents/codex/sessions \
  -H 'content-type: application/json' -d '{"cwd":"/path/to/repo"}'

curl -N 'http://127.0.0.1:3333/api/sessions/SESSION_ID/events?lastSeq=0'

curl -X POST http://127.0.0.1:3333/api/sessions/SESSION_ID/prompt \
  -H 'content-type: application/json' -d '{"text":"你好"}'
```

## 说明

- 会话事件日志只存在内存里，进程重启即丢。
- 单进程网关，没有鉴权层，不要直接暴露到公网。

## 许可

MIT