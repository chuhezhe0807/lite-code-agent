## 1. Controller：中断类型与历史修复

- [x] 1.1 在 `src/cli/controller.ts` 为 `abort()` 增加参数 `kind: "discard" | "resume"`（默认 `"discard"`），并在 `submit()` 内记录本轮中断类型供 catch 分支读取
- [x] 1.2 新增纯函数 `sanitizeForResume(messages)`：收集已出现的 `tool_call_id`，为最后一条 AIMessage 中悬空的 tool_call 各合成一条「已被用户中断」的 ToolMessage（带 tool_call_id/name），返回修复后的新数组
- [x] 1.3 改造 `submit()` 的 `abort.signal.aborted` 分支：`discard` 维持现状丢弃并提示「已中断。」；`resume` 调用 `sanitizeForResume(collected)` 写入 `this.history` 并提示「已中断，请输入纠正指令后继续」
- [x] 1.4 确认 `finally` 仍 `emit("phase", "idle")`，两种中断后都回到输入框

## 2. UI：Ctrl+C 续接与双击退出

- [x] 2.1 在 `src/cli/app.tsx` running 阶段 `useInput` 中新增 Ctrl+C 处理：用 `useRef<number>` 记录上次按下时间戳
- [x] 2.2 实现双击判定：窗口内（常量 ~1500ms）再次 Ctrl+C 调用 `exit()` 退出；否则记录时间戳并 `controller.abort("resume")`
- [x] 2.3 保留 Esc 分支调用 `controller.abort("discard")`，与 Ctrl+C 互不干扰
- [x] 2.4 集中定义双击时间窗口常量，便于调整

## 3. Ink Ctrl+C 拦截验证

- [x] 3.1 实测运行阶段单击 Ctrl+C 是否被 Ink 默认 `exitOnCtrlC` 抢先退出（直接关闭默认退出以规避，见 3.2）
- [x] 3.2 在 `startCli` 的 `render(...)` 传 `{ exitOnCtrlC: false }`，自行管理 running 双击退出与 idle 退出
- [x] 3.3 idle 阶段单按 Ctrl+C 直接 `exit()` 退出（无二次确认）：app.tsx 新增 idle 专用 useInput 调用 exit()，`promptInput.tsx` 仍吞掉 Ctrl+C 避免插入字符，保留 `/exit` 备用

## 4. 端到端验证

- [x] 4.1 运行中途按 Ctrl+C：界面回到输入框并显示续接提示，phase 回到 idle
- [x] 4.2 中断发生在工具结果返回前，输入纠正指令后提交：下一轮请求不报 400，agent 带上下文调整继续
- [x] 4.3 运行中快速连按两次 Ctrl+C：程序退出
- [x] 4.4 运行中按 Esc：提示「已中断。」，半截对话被丢弃，下一轮历史干净
- [x] 4.5 idle 阶段单按 Ctrl+C：程序退出（无二次确认）
- [x] 4.6 类型检查通过（`npm run typecheck`），无回归
