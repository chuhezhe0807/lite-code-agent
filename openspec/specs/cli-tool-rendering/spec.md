# cli-tool-rendering Specification

## Purpose

定义 CLI 在渲染模型发起的工具调用块（tool-call）时的展示规则，包括针对特定工具的专用展示形式与默认展示形式。

## Requirements

### Requirement: run_command 工具调用直显命令

当 CLI 渲染一个工具调用块（tool-call）且其工具名为 `run_command` 时，系统 MUST 以「执行工具名包裹命令」的形式展示该调用的 `command` 参数内容，即 `Bash(<command>)`，而不展示「⚙ 调用工具：<工具名>」标题，也不展示 JSON 序列化后的参数。展示内容 MUST 沿用既有的字符数裁剪逻辑，仅影响展示、不改变发送给模型的内容。

#### Scenario: 渲染 run_command 调用

- **WHEN** 模型发起一个工具名为 `run_command`、参数为 `{ "command": "cd examples && npm test" }` 的工具调用
- **THEN** CLI 在该块中展示 `Bash(cd examples && npm test)`
- **AND** 不展示「⚙ 调用工具：run_command」标题
- **AND** 不展示 `{"command":"cd examples && npm test"}` 这样的 JSON 参数

#### Scenario: 长命令仍按字符数裁剪

- **WHEN** `run_command` 的展示文本 `Bash(<command>)` 长度超过展示上限
- **THEN** CLI 按既有裁剪规则截断展示并追加省略提示
- **AND** 发送给模型的工具调用内容保持完整、不受裁剪影响

### Requirement: 其他工具调用渲染保持不变

当工具名不是 `run_command` 时，系统 MUST 维持原有渲染方式，即展示「⚙ 调用工具：<工具名>」标题并展示其 JSON 参数（经字符数裁剪）。

#### Scenario: 渲染非 run_command 工具调用

- **WHEN** 模型发起一个工具名为 `update_todos` 的工具调用
- **THEN** CLI 展示「⚙ 调用工具：update_todos」标题
- **AND** 展示该调用的 JSON 参数
