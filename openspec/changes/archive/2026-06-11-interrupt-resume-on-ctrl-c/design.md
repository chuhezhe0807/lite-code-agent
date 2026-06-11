## Context

中断目前由 `SessionController.submit()` 与 `app.tsx` 协作实现：

- `submit()`（`src/cli/controller.ts:146`）为每轮创建 `AbortController`，把 `signal` 透传给 `graph.stream`，贯穿 LLM 调用与工具执行。流式过程中把每条消息累积进本地 `collected`，并实时渲染。
- 正常结束时 `this.history = [...this.history, ...collected]`（`controller.ts:188`）沉淀历史。
- 被中断时（`abort.signal.aborted`），当前实现**丢弃** `collected`、提示「已中断。」（`controller.ts:190-193`）。注释明确说明丢弃的原因：避免遗留「有 tool_use 却无 tool_result」的悬空消息导致下轮请求 400。
- UI 侧仅在 `phase === "running"` 时用 `useInput` 捕获 `key.escape` 调用 `controller.abort()`（`app.tsx:244-249`）。`promptInput.tsx:85` 在 idle 阶段吞掉 Ctrl+C。

关键约束：Anthropic / LangChain 消息序列要求每个 `tool_use`（AIMessage.tool_calls）都有配对的 `tool_result`（ToolMessage，匹配 `tool_call_id`），否则下一轮请求 400。这正是「续接式中断」必须解决的核心问题。

## Goals / Non-Goals

**Goals:**
- 运行阶段单击 Ctrl+C：中断当前轮、回到输入框、**保留上下文**，下一条输入作为纠正指令让 agent 续接。
- 续接式中断时，为悬空 tool_call 合成「已被用户中断」的 tool_result，保证写入历史的序列合法。
- 运行阶段双击/快速连按 Ctrl+C：退出程序。
- 保留 Esc = 中断并丢弃 的现有行为，与 Ctrl+C 续接语义并存。

**Non-Goals:**
- 不实现「中断后从工具执行的精确断点续跑」——续接是语义层面的（带上下文重新让模型决策），而非恢复被 abort 的具体工具调用。
- 不引入新依赖、不改对外 API。

## Decisions

### 决策 1：中断类型由 `abort(kind)` 携带，submit 据此分流

为 `controller.abort()` 增加参数 `kind: "discard" | "resume"`（默认保持 `"discard"` 以兼容 Esc）。`submit()` 内记录本轮中断类型（如在闭包/实例字段中），`catch` 分支据此选择：
- `discard`：维持现状——丢弃 `collected`，提示「已中断。」。
- `resume`：调用 `sanitizeForResume(collected)` 修复后写入历史，提示「已中断，请输入纠正指令后继续」。

**为什么**：中断信号源头在 UI（Esc vs Ctrl+C），而历史处理逻辑在 controller。用参数把「意图」从 UI 传到 controller，避免 controller 猜测，职责清晰。

**备选**：为两种中断各开一个方法（`abortDiscard()` / `abortResume()`）。语义同样清晰，但 `abort(kind)` 更紧凑、调用点改动小。二者皆可，实现时取其一即可。

### 决策 2：合成中断 tool_result 修复悬空 tool_call

新增纯函数 `sanitizeForResume(messages: BaseMessage[]): BaseMessage[]`：
- 收集所有已出现的 `tool_call_id`（来自 ToolMessage）。
- 找出最后一条 AIMessage 中 `tool_calls` 里**没有**对应 ToolMessage 的 id。
- 为每个悬空 id 追加一条 `new ToolMessage({ content: "[已被用户中断，未执行/未完成]", tool_call_id, name })`。
- 返回修复后的数组（不改原数组），供写入 `this.history`。

**为什么**：这是让「带上下文续接」不触发 400 的最小且正确的做法，与 Claude Code 注入 `[Request interrupted by user]` tool_result 的做法一致。模型在下一轮看到「这个工具被用户中断了」+ 用户的纠正指令，能自然地调整决策。

**备选**：直接删除悬空的 tool_call（改写 AIMessage）。但改写模型已产出的消息更易破坏内容块结构（文本+tool_use 混排），且丢失「agent 当时想做什么」的信息，不利于续接。故选择「补 result」而非「删 call」。

### 决策 3：双击 Ctrl+C 退出，用时间窗口在 UI 层判定

在 `app.tsx` 的 running 阶段 `useInput` 中处理 Ctrl+C：
- 记录上次 Ctrl+C 时间戳（`useRef<number>`）。
- 若距上次按下在窗口内（如 ≤ 1500ms），调用 `exit()` 退出。
- 否则记录时间戳并执行 `controller.abort("resume")`，回到 idle。
- 时间窗口常量集中定义，便于调整。

idle 阶段单按 Ctrl+C 直接退出程序（已确认，无需二次确认提示）。这与运行阶段语义自洽：running → Ctrl+C（续接，回到 idle）→ 再按 Ctrl+C（此时已在 idle）→ 退出，整体即「双击退出」。idle 阶段的 Ctrl+C 处理需从 `promptInput.tsx`（当前吞掉 Ctrl+C）上移或改为调用 `exit()`。

**为什么**：双击判定是纯 UI 交互状态，放在视图层最合适；controller 不需要知道按键节奏。Esc 分支继续调用 `controller.abort("discard")`，互不干扰。

**注意**：Ink 默认在 Ctrl+C 时退出（`exitOnCtrlC`）。实现时需确认我们的 `useInput` 能拦截 Ctrl+C 而不被 Ink 默认退出抢先；若被抢先，则在 `render(...)` 时传 `{ exitOnCtrlC: false }` 并自行管理退出（含 idle 退出与 running 双击退出）。这一点在 tasks 中作为验证项。

### 决策 4：中断回到 idle 由 phase 事件驱动

`submit()` 的 `finally` 已 `emit("phase", "idle")`，故无论 discard 还是 resume，中断后都会回到 idle、重新渲染输入框。续接式中断无需额外的 phase 机制，仅提示文案不同。

## Risks / Trade-offs

- **[Ink 抢先处理 Ctrl+C 导致直接退出]** → 在 `render` 设 `exitOnCtrlC: false`，由 running 阶段 `useInput` 全权管理 Ctrl+C；并自行保证 idle 阶段也有合理的退出路径（保留 `/exit`，必要时 idle 也接管 Ctrl+C 退出）。tasks 中需实测验证。
- **[合成 tool_result 后模型仍可能困惑]** → 中断 result 文案明确（「已被用户中断」），并依赖用户随后的纠正指令提供方向；属可接受的语义近似，非精确续跑（见 Non-Goals）。
- **[双击窗口选得过短/过长]** → 取 ~1500ms 折中；常量集中，后续按反馈调整。
- **[多个悬空 tool_call]** → `sanitizeForResume` 对每个 id 都补 result，覆盖一次 AI 消息发起多工具调用的情况。
- **[与 IME 候选框光标逻辑的交互]** → 中断只切换 phase，输入框重新挂载即可；与 `promptInput.tsx` 的光标定位无冲突。

## Open Questions

- 无（已确认：idle 单按 Ctrl+C 直接退出；退出前不做二次确认）。
