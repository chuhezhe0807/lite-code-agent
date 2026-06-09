## 1. 实现 run_command 命令直显

- [x] 1.1 在 `src/cli/app.tsx` 的 `BlockView` `case "tool-call"` 分支中，判断 `block.toolName === "run_command"`
- [x] 1.2 对 `run_command`：用 try/catch 解析 `block.text` 为对象并取 `command` 字段，仅渲染 `clampCount(command)`，不渲染「⚙ 调用工具」标题与 JSON 参数
- [x] 1.3 解析失败或缺少 `command` 字段时回退到原有通用渲染
- [x] 1.4 非 `run_command` 工具保持原有渲染（标题 + JSON 参数）

## 2. 验证

- [x] 2.1 运行类型检查 / 构建，确认无类型错误
- [x] 2.2 手动运行 CLI，触发一次 `run_command` 调用，确认终端只显示命令文本
- [x] 2.3 触发一次非 `run_command`（如 `update_todos`）调用，确认仍显示工具名标题与参数
