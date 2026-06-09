## Context

工具调用块在 `src/cli/app.tsx` 的 `BlockView` 中由 `case "tool-call"` 统一渲染：一行「⚙ 调用工具：<toolName>」标题，下面一行 `clampCount(block.text)`，其中 `block.text` 是 `JSON.stringify(call.args)`（见 `src/cli/controller.ts` 的 `renderMessage`）。`Block` 类型（`src/cli/types.ts`）目前只有 `kind` / `text` / `toolName` 三个字段。`run_command` 工具的参数 schema 中命令字段名为 `command`。

## Goals / Non-Goals

**Goals:**
- `run_command` 的工具调用块在终端直接展示命令文本，去掉工具名标题与 JSON 包裹。
- 其余工具渲染行为完全不变。
- 改动局限在 CLI 渲染层，不触碰 agent / 工具执行 / 发送给模型的消息。

**Non-Goals:**
- 不改变命令的裁剪上限或裁剪算法。
- 不为其他工具引入专属渲染特例。
- 不改变 tool-result 块的渲染。

## Decisions

- **在视图层 `BlockView` 中按 `toolName === "run_command"` 分支渲染**，而不是在 controller 中预先把文本改写。理由：渲染样式属于视图职责；controller 只负责把结构化数据（toolName + args）透传，保持单一数据来源，便于将来调整样式或新增特例。
  - 备选：在 `controller.renderMessage` 里针对 `run_command` 直接把 `text` 设为命令字符串。缺点是把展示逻辑泄漏进数据层，且丢失原始 args 结构。已否决。
- **命令内容来源**：保持 `block.text = JSON.stringify(call.args)` 不变，在 `BlockView` 内解析出 `command` 字段展示。若解析失败或字段缺失，回退到原有的通用渲染，保证健壮性。
  - 备选：在 `Block` 类型上新增可选 `command` 字段并在 controller 填充。更直观但需要改三个文件且扩散类型；当前仅一个特例，先用视图内解析，保留后续重构空间。

## Risks / Trade-offs

- [`block.text` 不是合法 JSON 或缺少 `command` 字段] → 在 `BlockView` 内用 try/catch 解析，失败时回退通用渲染，不抛错。
- [未来 `run_command` 参数字段重命名] → spec 与实现都以 `command` 为契约，字段变更时需同步更新本特例（影响面已在 spec 中固定）。
