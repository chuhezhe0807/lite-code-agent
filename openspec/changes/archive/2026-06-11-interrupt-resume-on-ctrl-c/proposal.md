## Why

用户在 agent 回答/执行过程中，常会发现「自己刚才的指令写错了」或「agent 理解偏了」，但当前只能用 Esc 中断——而 Esc 会**丢弃**这半截对话（为避免悬空 tool_use 导致下轮 400）。结果用户无法在 agent 已经做了一部分工作的基础上做小幅纠偏，只能从零重述，体验割裂、浪费已产出的上下文。本变更让用户能用更符合终端直觉的 Ctrl+C 中断、补充纠正指令，并让 agent **带着「之前做到哪」的上下文**继续执行。

## What Changes

- 在 `running` 阶段新增 **Ctrl+C** 中断键：单击中断当前轮、回到输入框等待用户补充纠正指令（「续接式中断」）。
- 续接式中断**保留上下文**：对中断时悬空的 tool_call 合成一条「已被用户中断」的 `tool_result`，使消息序列合法，并把这半截对话写入历史；用户下一条输入作为纠正指令，agent 据此调整并继续。
- 运行中**双击 / 快速连按 Ctrl+C 退出程序**（终端常见约定）。
- 保留现有 **Esc = 中断并丢弃** 行为不变（用于「彻底放弃本轮、不留痕迹」的场景）。
- UI 在续接式中断后给出明确提示（如「已中断，请输入纠正指令后继续」），与 Esc 的「已中断。」区分。

## Capabilities

### New Capabilities
- `agent-interruption`: agent 运行期间的中断语义——包括 Ctrl+C 续接式中断（保留上下文、回到输入框、合成中断 tool_result）、双击 Ctrl+C 退出、Esc 丢弃式中断，以及中断后历史的合法性保证。

### Modified Capabilities
<!-- 无既有 spec，全部为新增 -->

## Impact

- `src/cli/controller.ts`：`submit()` 的 abort 处理分支需区分「续接（保留并修复历史）」与「丢弃」两种中断；新增对悬空 tool_call 合成中断 tool_result 的逻辑；`abort()` 需携带中断类型。
- `src/cli/app.tsx`：`running` 阶段的 `useInput` 新增 Ctrl+C 处理（单击续接、连按退出），保留 Esc 续旧逻辑；中断后回到 idle 输入框；新增双击计时状态。
- `src/cli/types.ts`：可能新增中断类型 / phase 相关类型。
- 无新增依赖；不改变对外 API；不影响 Langfuse 上报路径。
