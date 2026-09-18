# acp-hub 验收指南

本文档说明如何验收 acp-hub 的全部交付物。按顺序执行第 1–4 节即可完成**核心验收**（约 5 分钟，无需安装任何真实 agent）；第 5 节为**真实 agent 验收**（可选，需要已登录的 agent CLI）；第 8 节是逐项核对清单。

## 0. 验收范围

| 交付物 | 说明 |
| --- | --- |
| `packages/core` | 统一契约（AgentAdapter/AgentSession/SessionEvent 类型）+ ACP 传输层（spawn/握手/流式/权限桥接/steering/批处理/进程生命周期） |
| `packages/adapter-claude` `-codex` `-pi` `-deepseek` | 4 个适配器包（启动配置 + 类型再导出） |
| `packages/conformance` | 一致性测试套件（场景运行器 + 11 个场景 + CLI） |
| `packages/gateway` | HTTP+SSE 网关（下游无需 Node/ACP 知识即可调用） |
| `examples/quickstart` | 下游用法示例 |
| `examples/fake-agent` | 假 ACP agent（验证用，模拟流式/工具/权限全流程） |
| `docs/ACCEPTANCE.md` | 本文档 |

## 1. 环境准备

要求：Node.js ≥ 20、pnpm ≥ 10（开发环境用的是 node 24.20 + pnpm 11.20）。

```bash
node -v   # 预期 ≥ v20.x
pnpm -v   # 预期 ≥ 10.x
```

## 2. 安装与构建

```bash
cd <项目根目录>
pnpm install
pnpm build
```

**预期结果**：7 个包全部输出 `Done`，无 `error TS`：

```
packages/core build: Done
packages/adapter-claude build: Done
packages/adapter-codex build: Done
packages/adapter-deepseek build: Done
packages/adapter-pi build: Done
packages/conformance build: Done
packages/gateway build: Done
```

## 3. 核心验收（三条命令）

### 3.1 Harness 端到端冒烟

```bash
pnpm smoke
```

**预期输出**：

```
[smoke] handshake ok (protocol=1)
[smoke] turn ok — 7 events, stopReason=end_turn
[smoke] resume ok
SMOKE OK
```

这一条验证了完整链路：spawn 子进程 → ACP `initialize` 握手（协议版本 + `_meta` 扩展能力读取）→ `session/new` → `session/prompt` 流式 `message_delta` → `commands_update` 翻译 → 工具调用生命周期 → 权限双向往返（requestId 关联）→ `plan` → `stopReason=end_turn` → `session/load` 恢复 → 进程清场。

对应代码：`packages/core/src/acp/`（connection.ts / session.ts / translate.ts）。

### 3.2 一致性测试套件自检

```bash
pnpm selftest
```

**预期输出**（11 个场景全 PASS，0 failed）：

```
Conformance: fake-agent (selftest) — 11 passed, 0 failed, 0 skipped
  PASS handshake
  PASS turn-completes
  PASS events-are-typed
  PASS single-active-prompt
  PASS session-resume
  PASS streaming-assembles
  PASS commands-surfaced
  PASS tool-lifecycle
  PASS permission-roundtrip
  PASS plan-update
  PASS steering-gate
```

场景含义：前 5 个是**基线场景**（任何合格 ACP agent 都必须通过）；后 6 个是**严格场景**，验证 harness 的翻译层（流式拼装、commands 翻译、工具生命周期、权限往返、plan、steering 能力门控）。

对应代码：`packages/conformance/src/`（scenarios.ts / runner.ts）。

### 3.3 HTTP+SSE 网关冒烟

```bash
pnpm gateway:smoke
```

**预期输出**：

```
GATEWAY SMOKE OK
```

这一条验证下游"无需知道 ACP"的调用方式：HTTP 创建会话 → SSE 订阅事件流（批窗口合并推送）→ POST prompt（202 受理）→ 并发 prompt 被 409 拒绝 → SSE 收到流式文本 + 权限自动应答 + `turn_completed` → DELETE 会话 → 404。

对应代码：`packages/gateway/src/server.ts`。

### 3.4 多端收敛 / 断线重放验收

```bash
pnpm gateway:replay
```

**预期输出**：

```
[replay] client A watched the turn live: 6 frames, seq 1..6
[replay] client B (lastSeq=0) converged: identical frame sequence
[replay] client C (lastSeq=1) converged: frames 2..head, exactly A minus frame 1
[replay] client D (lastSeq=3) converged: frames 4..head
REPLAY SMOKE OK
```

这一条验证"电脑在输出、手机中途打开，两端恢复到同一个节点"的等价能力：

- 每条 SSE 内容帧带**会话内单调 `seq`**（帧内 `seq` 字段 + SSE 标准 `id:` 行）；
- 客户端重连时带 `?lastSeq=N` → 服务端**精确重放 N+1..head** 再切直播（无缺口、无重复，与在线客户端逐字节一致）；
- `lastSeq=0` = 全量重放（快照等价物）；省略参数 = 只看直播；
- `lastSeq` 越界（ ahead of log）或非法值 → **400 拒绝**（暴露客户端 bug 而不是静默分叉）。

测试模拟了 4 个客户端：A 在线看完整 turn，B/C/D 分别以 lastSeq=0/1/3 断线重连，断言四者最终帧序列完全一致。

对应代码：`packages/gateway/src/server.ts`（broadcast/sseSubscribe 的 seq+log 机制）、`packages/gateway/scripts/replay-smoke.mts`。

> 生产注意：当前重放日志在**内存**中（daemon 重启即失）。真实部署时把 log 持久化到 SQLite 一张 append 表即可获得跨重启的恢复能力——接口不变。

## 4. 下游类型引入验收

检查"下游 import 即用"是否成立——打开 `examples/quickstart/src/main.ts`，确认：

1. 只从适配器包导入（`acp-hub-adapter-codex` 等），不直接依赖 `@agentclientprotocol/sdk`；
2. 所有事件分支（`message_delta`/`tool_call`/`permission_request`/…）都有完整的 TypeScript 类型提示，`event.type` 收窄正常；
3. 换 agent 只换工厂函数，其余代码零改动。

可运行类型检查佐证：

```bash
pnpm typecheck   # 预期全部通过，无输出
```

## 5. 真实 agent 验收（可选）

前提：本机已安装并**登录**对应 CLI（Codex CLI 或 Claude Code CLI）。

```bash
# Codex
pnpm --filter acp-hub-example-quickstart codex "用一句话介绍你自己"

# Claude Code
pnpm --filter acp-hub-example-quickstart claude "用一句话介绍你自己"
```

**预期结果**：终端流式打印回复文本，工具调用/权限请求逐条输出，最后打印 `[hub] turn finished: end_turn`。

真实 agent 的一致性测试（基线场景）：

```bash
pnpm --filter acp-hub-conformance exec tsx src/cli.ts --command npx --args "-y,acp-extension-codex" --label codex
```

**Steering（插话）验收**：`acp-extension-codex` 在 `_meta.lody.steering` 广告了 request 传输（已从 Lody 源码核实），harness 会自动走 `_lody/session/steer`。验证方式：在 turn 进行中调用 `session.steer('新的指示')`，预期返回 `{ accepted: true, steerId }`。未广告 steering 的 agent 调用 steer 会抛 `AdapterError(code='unsupported')`（selftest 的 `steering-gate` 场景已验证此门控）。

## 6. 手动体验网关（可选）

```bash
node -e "import('./packages/gateway/dist/index.js').then(async m => { const g = m.createGatewayServer({ agents: { codex: { launch: { command: 'npx', args: ['-y','acp-extension-codex'] } } } }); const port = await g.listen(3333); console.log('gateway on', port); })"
```

另开终端：

```bash
curl -X POST http://127.0.0.1:3333/api/agents/codex/sessions -H "content-type: application/json" -d "{\"cwd\":\"<你的项目路径>\"}"
# → {"sessionId":"..."}

curl -N http://127.0.0.1:3333/api/sessions/<sessionId>/events
# → SSE 流

curl -X POST http://127.0.0.1:3333/api/sessions/<sessionId>/prompt -H "content-type: application/json" -d "{\"text\":\"你好\"}"
# → {"accepted":true}，SSE 里看到 data: {"kind":"events",...} 与 {"kind":"turn_completed",...}
```

## 7. 已知限制（验收时不算缺陷）

1. **pi / Oh My Pi、DeepSeek 的启动参数未实测**（代码内有 `TODO(unverified)` 标记）：pi 的 `--mode acp` 参数、DeepSeek 公开 ACP 入口需接入时确认，接入成本 = 改一行 launch 配置。
2. **claude/codex 适配器的默认命令未经真实 agent 实测**（本环境无已登录 CLI）；命令本身来自官方/Lody 维护的公开包。
3. **steering happy-path** 依赖真实 Lody 兼容适配器（机制代码 + 门控已验证，见 §5）。
4. **elicitation**（`elicitation/create`）事件类型已预留、未接桥接。
5. prompt-transport steering 未自动化（消费者可直接发后续 prompt 替代），见 `packages/core/src/acp/steering.ts` 注释。

## 8. 验收清单（逐项核对）

| # | 项 | 命令 | 通过标准 |
| --- | --- | --- | --- |
| 1 | 构建 | `pnpm build` | 7 包全部 `Done`，无类型错误 |
| 2 | Harness E2E | `pnpm smoke` | 输出 `SMOKE OK`（握手/流式/权限/恢复/清场） |
| 3 | Conformance | `pnpm selftest` | `11 passed, 0 failed` |
| 4 | 网关 | `pnpm gateway:smoke` | 输出 `GATEWAY SMOKE OK` |
| 5 | 多端收敛 | `pnpm gateway:replay` | 输出 `REPLAY SMOKE OK`（4 客户端帧序列一致 + 越界 400） |
| 6 | 类型检查 | `pnpm typecheck` | 无输出（全过） |
| 7 | 下游引入 | 审阅 `examples/quickstart/src/main.ts` | 只 import 适配器包、事件类型收窄完整 |
| 8 | 真实 agent（可选） | §5 命令 | 流式输出 + `turn finished: end_turn` |

第 1–6 项全部通过即视为核心验收通过。
