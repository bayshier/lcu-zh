# Harness 适配器（中文）

> 本文档为中文精译，覆盖核心契约与各适配器要点；深水区细节（诊断日志、Linux 沙箱逐条分析、验证记录）请阅读[英文原文](https://github.com/amontlabs/lcu/blob/main/docs/ADAPTERS.md)。

LCU 让所选已安装应用的原版 CUA MCP 服务器在指令、执行、引出（elicitation）、策略与生命周期上保持权威。LCU 自己不实现浏览器控制、截图、无障碍、输入或 JavaScript 执行。Pi 客户端、Claude 中继与 Codex 中继都使用官方 MCP SDK。Codex 中继透传原版初始化指令与公开的 `js`/`js_reset` 描述符，但有意在模型可见的 `tools/list` 中省略 `js_add_node_module_dir` 与 `turn_ended`——这是显式的可见性适配，不是完全对等。

## 共享客户端契约

```js
import { createCuaClient } from './adapters/client.mjs';

const cua = createCuaClient({
  command: ['/absolute/path/to/lcu'],
  onElicitation: async params => {
    // 渲染原版请求。此占位实现直接取消。
    return { action: 'cancel' };
  },
});
await cua.connect();
const instructions = cua.instructions; // 原版 MCP 初始化指令
const tools = cua.publicTools();       // 原版 js 与 js_reset 描述符
const result = await cua.call('js', { code: 'await cua.getState()' }, { sessionId, turnId });
// 原样转发 result.content 与 result.isError 给模型。
await cua.turnEnded({ sessionId, turnId, event: 'Stop' });
await cua.close();
```

**宿主义务**：首次 CUA 调用之前，宿主必须把原版初始化指令与公开工具描述符放进模型上下文（官方 Codex 就是这么做的）。LCU 不注册任何 skill。原样转发原版结果内容与错误状态。保持一条连接贯穿整个回合，并使用宿主真实的会话/回合 ID。`turn_ended`、`js_add_node_module_dir` 与 Claude 的 `set_turn_context` 是宿主专用工具，不要暴露给模型。只对宿主上报的生命周期事件调用原版清理。`onElicitation` 缺席时共享客户端会取消未决的引出；否则渲染原版请求并返回用户的真实应答。`allowedOrigins` 只用于用户明确批准的精确 HTTP(S) 来源。LCU 不保留任何权限缓存。

## 各适配器要点

- **Claude Code（含 Claude 应用）**：harness 把 Claude 中继作为 stdio MCP 服务器启动。`lcu setup --agent claude-code` 额外安装 `lcu-approve` 模组，把应用审批原生地问出来（应用内问题卡片 / 终端审批面板），并提供 `/computer-use-apps` 已批准应用面板。可选的跨回合设置让 Computer Use 不随回合结束。需要 Claude Code 2.1.287+。
- **Codex CLI**：通过 MCP 注册接入；需要较新的 CLI 版本（`npm install -g @openai/codex@latest`）以支持 `mcp_tool` hooks。中继透传原版指令与 `js`/`js_reset`。
- **Pi / Oh My Pi / Hermes**：共享客户端运行在 harness 进程内，原版 MCP 进程的 stderr 被持续读取并转为[诊断日志](https://github.com/amontlabs/lcu/blob/main/docs/ADAPTERS.md#diagnostic-log)中的 `upstream_stderr` 事件（按前缀分类、不含原文）。OMP 与 Hermes 为实验性集成，宣称桌面行为前先读英文原文的验证限制小节。
- **通用 MCP 客户端（ZCode 等）**：直接把 `lcu mcp` 注册为 stdio MCP 服务器。这类客户端不会发送 Codex 特有的 `codex/sandbox-state-meta` 沙箱元数据；macOS 上这不影响桌面控制，Linux 上的沙箱行为差异见英文原文的 [Linux sandbox state](https://github.com/amontlabs/lcu/blob/main/docs/ADAPTERS.md#linux-sandbox-state) 小节。

## macOS 权限与审批边界

- 运行时保留原版的按应用审批：Agent 第一次控制某个应用时会弹出请求；「总是允许」由触控 ID（或密码）确认，可经 `lcu apps` 或 `/computer-use-apps` 撤销。
- 承载 Agent 的应用本身永远不会被批准；Terminal、iTerm2 等被 Computer Use 直接拒绝。
- 审批边界之外的一切照旧：你的 harness 决定工具调用是否放行；macOS 隐私权限（辅助功能、屏幕录制）需要在首次使用时由用户批准。

## Linux 沙箱状态（摘要）

原版 `node_repl` 默认把 JavaScript 内核跑在 bubblewrap + seccomp 沙箱里，而 Sky 桌面服务需要访问 X11——在沙箱内必然失败。LCU（0.9.3 起）通过 `bin/lcu-codex-sandbox` 垫片让 **Sky worker 在沙箱外运行、内核保持沙箱内**，且垫片 fail-closed：只放行它能精确分类的 worker 命令（父进程、Node 路径、脚本位置、环境变量白名单逐项校验），其余一切交还原版 `codex sandbox`。发送 `disabled` 沙箱策略的宿主得到无沙箱内核（宿主自己的决定）。完整逐条分析见英文原文。

## 已知限制

- Windows 有 Sky 目标的按应用审批，但 LCU 官方验证覆盖 macOS 与 Linux；Windows 上的行为以英文原文的最新说明为准。
- OMP 与 Hermes 为实验性：它们的验证记录里明确列出了未经覆盖的桌面行为，请勿在验证边界之外宣称功能。
- 通用 MCP 客户端没有 `turn_ended`/`set_turn_context` 等宿主工具的宿主侧实现，跨回合与回合内清理语义由各客户端自行负责。
