## Why

当前所有工具调用在 CLI 中都用统一的「⚙ 调用工具：<工具名>」加 JSON 参数的方式渲染。对于 `run_command` 工具，用户真正关心的是执行了什么命令，而 `run_command` + `{"command":"..."}` 这种包裹既冗余又难读。直接展示命令本身能让终端输出更接近用户在 shell 里看到的样子，降低认知负担。

## What Changes

- 当工具调用的工具名为 `run_command` 时，CLI 不再渲染「⚙ 调用工具：run_command」标题，也不再渲染 JSON 参数，而是直接展示其 `command` 字段的命令内容。
- 其他工具的渲染保持不变（仍显示「⚙ 调用工具：<工具名>」+ 参数）。
- 命令内容沿用现有的字符数裁剪逻辑（`clampCount`），保持仅影响展示、不影响发给模型内容的约束。

## Capabilities

### New Capabilities
- `cli-tool-rendering`: CLI 中模型工具调用与结果在终端的展示规则，包含针对 `run_command` 的命令直显特例。

### Modified Capabilities
<!-- 无既有 spec 需要修改 -->

## Impact

- 代码：`src/cli/app.tsx`（`BlockView` 的 `tool-call` 分支）；可能涉及 `src/cli/controller.ts` 与 `src/cli/types.ts` 以便把命令内容透传到渲染层。
- 不影响 agent 业务逻辑、工具执行、发送给模型的消息内容。
