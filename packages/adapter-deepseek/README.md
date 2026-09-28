# @cc-heart/acp-hub-adapter-deepseek

[acp-hub](https://github.com/CarlOpenLab/acp-hub) 的 DeepSeek 适配器 —— **实验性，未经端到端验证**。

## 状态

DeepSeek 官方目前没有公开的 ACP 入口。本包默认启动命令是裸命令：

```
deepseek-harness-acp
```

`deepseek-harness-acp` 确实存在于 npm（v0.1.31，MIT，bin 为 `deepseek-harness-acp` 与 `dsh-acp`），但它是第三方个人项目，不是 DeepSeek 官方包，且本适配器**没有对它做过端到端验证**。接到任何真实的 ACP 入口时，覆盖 `command` / `args` 即可。

## 安装

```bash
npm install @cc-heart/acp-hub-adapter-deepseek
```

## 用法

```ts
import { createDeepSeekAdapter } from '@cc-heart/acp-hub-adapter-deepseek';

// 默认是裸命令（要求全局安装）。想免安装就显式传 npx：
const adapter = createDeepSeekAdapter({
  command: 'npx',
  args: ['-y', 'deepseek-harness-acp'],
});

const session = await adapter.createSession({ cwd: process.cwd() });
console.log((await session.prompt('用一句话介绍你自己')).stopReason);
await adapter.dispose();
```

## 说明

- `agentId` 是 `'deepseek'`。
- 本包 re-export 了 `@cc-heart/acp-hub-core` 的全部内容，只装这一个包也能拿到 `AgentAdapter` 等核心类型。
- 用不了是正常的：这个包的存在意义是先把接口位置占住，等有可用的 ACP 入口再填。

## 许可

MIT