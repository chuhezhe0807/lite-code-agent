# agent-interruption Specification

## Purpose

定义 agent 运行过程中的中断能力，区分两种语义：Ctrl+C 的「续接式中断」（保留并修复历史上下文以便用户补充纠正指令后继续）与 Esc 的「丢弃式中断」（终止当前轮并丢弃这半截对话）。同时约定 Ctrl+C 在空闲态退出程序、运行态双击退出的终端约定行为。

## Requirements

### Requirement: Ctrl+C 续接式中断

当 agent 处于运行（`running`）阶段时，系统 SHALL 支持用户按下 Ctrl+C 中断当前轮的执行，并回到输入框等待用户补充纠正指令。此中断 MUST 终止正在进行的 LLM 调用与工具执行（通过 abort signal），且 MUST 保留中断前已产生的上下文，使后续输入能在此基础上继续。

#### Scenario: 运行中按 Ctrl+C 中断并回到输入框
- **WHEN** agent 处于 `running` 阶段且用户按下 Ctrl+C
- **THEN** 系统终止当前轮的流式执行
- **AND** 界面给出明确提示（区别于 Esc 的提示），告知用户可输入纠正指令后继续
- **AND** phase 回到 `idle`，输入框重新可用

#### Scenario: 空闲时按 Ctrl+C 退出程序
- **WHEN** agent 处于 `idle` 阶段（无运行中的轮次）且用户按下 Ctrl+C
- **THEN** 系统不执行续接式中断逻辑
- **AND** 程序直接退出（无二次确认提示）

### Requirement: 续接式中断保留并修复历史上下文

续接式中断后，系统 SHALL 把中断前已产生的这半截对话写入历史。若中断发生在某个 tool_call 已发起但其 tool_result 尚未返回时，系统 MUST 为每个悬空的 tool_call 合成一条标记为「已被用户中断」的 tool_result，使写入历史的消息序列满足 tool_use/tool_result 配对约束，避免下一轮请求因悬空 tool_use 被模型 API 拒绝（400）。

#### Scenario: 中断发生在工具结果返回前
- **WHEN** 续接式中断时，最后一条 AI 消息包含一个或多个尚无对应结果的 tool_call
- **THEN** 系统为每个悬空 tool_call 合成一条内容表明「已被用户中断」的 tool_result
- **AND** 将修复后的消息序列写入历史

#### Scenario: 中断后下一轮带上下文继续
- **WHEN** 续接式中断后用户输入一条纠正指令并提交
- **THEN** 新一轮请求的历史包含中断前的上下文及合成的中断 tool_result
- **AND** agent 据此调整并继续，而非从零开始
- **AND** 该轮请求不因悬空 tool_use 报错

#### Scenario: 中断时无悬空工具调用
- **WHEN** 续接式中断时最后一条消息不含未完成的 tool_call（如仅有部分文本回答）
- **THEN** 系统直接将已产生的消息写入历史，无需合成 tool_result

### Requirement: 双击 Ctrl+C 退出程序

运行阶段，系统 SHALL 在用户于短时间窗口内连续按下两次 Ctrl+C 时退出程序，遵循终端常见约定。单次 Ctrl+C MUST 仅触发续接式中断而不退出。

#### Scenario: 短时间内连按两次 Ctrl+C 退出
- **WHEN** 用户在运行阶段按下 Ctrl+C 后，于约定的时间窗口内再次按下 Ctrl+C
- **THEN** 程序退出

#### Scenario: 两次 Ctrl+C 间隔超过窗口不退出
- **WHEN** 用户两次 Ctrl+C 的间隔超过约定时间窗口
- **THEN** 第二次 Ctrl+C 被视为针对新一轮（或当前轮）的续接式中断，而非退出
- **AND** 程序不退出

### Requirement: Esc 丢弃式中断保持不变

系统 SHALL 保留既有的 Esc 中断行为：运行阶段按 Esc 终止当前轮，提示「已中断。」，并将这半截对话从历史中**丢弃**（不写入历史）。Esc 的丢弃语义 MUST 与 Ctrl+C 的续接语义相互独立、并存。

#### Scenario: 运行中按 Esc 丢弃式中断
- **WHEN** agent 处于 `running` 阶段且用户按下 Esc
- **THEN** 系统终止当前轮执行
- **AND** 提示「已中断。」
- **AND** 这半截对话不写入历史，下一轮从干净的历史开始
