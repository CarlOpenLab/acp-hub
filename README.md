# acp-hub

把主流 coding agent（Claude Code、Codex、pi/Oh My Pi、DeepSeek…）统一转译成**一套类型化的 TS 接口**，下游 import 即用。

以社区标准 [ACP（Agent Client Protocol）](https://agentclientprotocol.com) 为协议底座：每个 agent 一个独立适配器包，core 提供统一契约 + ACP 传输层。

```
下游代码（你的网关 / CLI / UI）
   │  只依赖统一类型：AgentAdapter / AgentSession / SessionEvent
   ▼
@cc-heart/acp-hub-adapter-*（每 agent 一个包，声明启动方式 + 特有选项）
   │  spawn 子进程，ACP JSON-RPC over stdio
   ▼
ACP 适配的 agent（@agentclientprotocol/claude-agent-acp / @agentclientprotocol/codex-acp / pi --mode acp / …）
```

## 包结构

| 包 | 作用 |
| --- | --- |
| `packages/core` | 统一契约（`AgentAdapter`/`AgentSession`/`SessionEvent`/错误码/能力协商）+ ACP 子进程传输层（spawn、握手、事件翻译、权限桥接、事件批处理、进程生命周期） |
| `packages/adapter-claude` | Claude Code（经 `@agentclientprotocol/claude-agent-acp`） |
| `packages/adapter-codex` | OpenAI Codex（经 `@agentclientprotocol/codex-acp`） |
| `packages/adapter-pi` | pi 与 Oh My Pi（同一 ACP 语义，两个启动预设） |
| `packages/adapter-deepseek` | DeepSeek（实验性，见下方状态表） |
| `packages/conformance` | 一致性测试套件：一个脚本化客户端跑所有适配器，断言相同行为（10 个场景） |
| `packages/gateway` | HTTP+SSE 网关：下游用纯 HTTP 调用 agent（10ms/100ms 批窗口推送；`?lastSeq=N` 断线重放，多端收敛到同一节点） |
| `examples/quickstart` | 下游用法示例 + 端到端冒烟测试 |
| `examples/fake-agent` | 假 ACP agent（验证用，无需装任何真 agent） |
| `docs/ACCEPTANCE.md` | **验收指南**：如何逐项验收本项目 |

## 快速开始

```bash
pnpm install
pnpm build                                      # 全部编译（7 个包）
pnpm smoke                                      # harness 端到端冒烟（假 agent）
pnpm selftest                                   # conformance 套件自检（10 场景）
pnpm gateway:smoke                              # HTTP+SSE 网关冒烟
pnpm gateway:replay                             # 多端收敛/断线重放测试

# 验收文档（逐项核对清单）：docs/ACCEPTANCE.md
```

接真实 agent：

```bash
pnpm --filter @cc-heart/acp-hub-example-quickstart codex   "用一句话介绍你自己"
pnpm --filter @cc-heart/acp-hub-example-quickstart claude  "用一句话介绍你自己"
```

（需要本机已装并登录 Codex CLI / Claude Code CLI。）

## 下游用法（这就是"引入即用"的形态）

```ts
import { createCodexAdapter } from '@cc-heart/acp-hub-adapter-codex';
// 或 createClaudeAdapter / createPiAdapter / createOhMyPiAdapter —— 接口完全相同

const adapter = createCodexAdapter();
const capabilities = await adapter.connect();          // ACP 握手 + 能力（含 _meta 扩展）
const session = await adapter.createSession({ cwd: process.cwd() });

const turn = session.prompt('帮我写个爬虫');

for await (const event of session.events) {           // 类型化事件流
  switch (event.type) {
    case 'message_delta':  process.stdout.write(event.text); break;
    case 'tool_call':      console.log(event.toolCall.title); break;
    case 'permission_request':
      await session.respondPermission(event.requestId, 'allow_once 对应的 optionId');
      break;
    // thought_delta / tool_call_update / plan / usage / mode_update / raw …
  }
}

const { stopReason } = await turn;                     // end_turn | max_tokens | refusal | …
await adapter.dispose();                               // SIGTERM → SIGKILL 清场
```

所有类型（`SessionEvent`、`ToolCall`、`UsageSummary`、`AgentCapabilities`…）都从适配器包再导出，下游不需要直接依赖 ACP SDK。

## 统一事件模型

| 统一事件 | ACP 来源 | 说明 |
| --- | --- | --- |
| `message_delta` | `agent_message_chunk` | 流式正文 |
| `thought_delta` | `agent_thought_chunk` | 流式思考 |
| `tool_call` / `tool_call_update` | 同名 | 统一 `ToolCall` 快照（status/kind/rawInput/rawOutput/content/locations） |
| `plan` | `plan` | 全量计划快照 |
| `usage` | `usage_update` | 上下文占用；缺失 cost = 未知，不是免费 |
| `mode_update` | `current_mode_update` | 会话模式（如 plan mode） |
| `commands_update` | `available_commands_update` | 可用斜杠命令列表 |
| `permission_request` | `requestPermission` 反向请求 | 桥接为带 `requestId` 的事件，`respondPermission/cancelPermission` 应答 |
| `raw` | 其余全部 | 未翻译的 ACP update 原样透传——下游永远不被翻译层卡住 |

设计规则（三档策略）：能用标准 ACP 信封的用标准；品牌私有语义放 `_meta`；只有 ACP 完全没有对应物时才加自定义方法。**消费者按 `event.type` 与能力字段分支，永不按 agent 名字分支。**

## 各 agent 接入状态

| Agent | 启动方式 | 状态 |
| --- | --- | --- |
| Codex | `npx -y @agentclientprotocol/codex-acp`（需本机装好并登录 Codex CLI） | 待实测 |
| Claude Code | `npx -y @agentclientprotocol/claude-agent-acp`（需本机装好并登录 Claude Code） | 待实测 |
| pi / Oh My Pi | 本地 CLI：`pi --mode acp` / `omp acp`（不走 npx；刻意不依赖第三方的 `pi-acp`） | 已按实测参数更新，仍待完整实测 |
| DeepSeek | 官方暂无公开 ACP 入口 | **实验性**；需自行补一层 ACP 薄壳后填入 `DEEPSEEK_ACP_DEFAULT` |

harness 本身（握手/流式/权限/生命周期/resume）已被 `scripts/smoke.mts` 用假 ACP agent 端到端验证。

## 路线图

- [x] core 契约 + ACP 传输层（握手/流式/权限/批处理/生命周期）
- [x] conformance 一致性测试套件（10 场景，baseline 可跑真实 agent）
- [x] HTTP+SSE 网关（10ms/100ms 批窗口；`lastSeq` 断线重放 + 多端收敛）
- [ ] 四个真实 agent 逐个实测（命令、环境变量、权限选项字典、工具名归一化）
- [ ] 会话恢复与历史持久化（`session/load` 已通，持久化待做）
- [ ] registry：社区 agent 以 npx/uvx/binary 声明接入，宿主零代码加载（ACP 官方已有 [`agentclientprotocol/registry`](https://github.com/agentclientprotocol/registry)，收录 42 个 agent）
- [ ] elicitation 桥接

## 设计来源

本项目只依赖公开的 [ACP 规范](https://agentclientprotocol.com) 本身：不内联、不改写任何第三方 ACP 实现的代码，也不使用其私有命名空间。需要借助第三方 ACP 服务器时（如 Codex、Claude Code），只按标准 ACP 的进程边界把它当作子进程启动。
