# @cc-heart/acp-hub-adapter-pi

[acp-hub](https://github.com/CarlOpenLab/acp-hub) 的 pi 家族适配器：pi 与 Oh My Pi 走同一套 ACP 语义，两个启动预设。

**本包不走 npx 下载任何东西**，要求本机已安装对应 CLI：

| 工厂函数 | 启动命令 | `agentId` |
| --- | --- | --- |
| `createPiAdapter()` | `pi --mode acp` | `'pi'` |
| `createOhMyPiAdapter()` | `omp acp` | `'oh-my-pi'` |

## 安装

```bash
npm install @cc-heart/acp-hub-adapter-pi
```

同时需要本机有 `pi`（pi-mono）和／或 `omp`（Oh My Pi v18+）。

## 用法

```ts
import { createPiAdapter } from '@cc-heart/acp-hub-adapter-pi';

const adapter = createPiAdapter();
const session = await adapter.createSession({ cwd: process.cwd() });
console.log((await session.prompt('用一句话介绍你自己')).stopReason);
await adapter.dispose();
```

切换成 Oh My Pi 只换一行：

```ts
import { createOhMyPiAdapter } from '@cc-heart/acp-hub-adapter-pi';
const adapter = createOhMyPiAdapter();
```

## 说明

- 启动参数按实测确认（2026-09-19）。
- 刻意**不依赖**第三方 `pi-acp` 包装包：pi 的 ACP 入口由 CLI 原生提供，多一层包装只会多一个可能掉队的依赖。
- npm 上的 `@mariozechner/pi` 是无关的 vLLM 工具包，不是本 Pi；`@earendil-works/pi` 尚未发布。
- npm 包 `oh-my-pi` 是 pi 的扩展，其 bin 是未编译的 TS 诊断脚本，**不能**作为 ACP 服务启动；必须用 `omp` 子命令。

## 许可

MIT