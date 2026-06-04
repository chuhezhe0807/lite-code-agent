/**
 * 工具注册中心
 *
 * 把所有工具聚合成一个带授权级别的数组。后续故事新增工具（write_file、edit_file、
 * run_command、update_todos）只需在这里 push 一项即可，主循环与授权层无需改动。
 */

import type { AppConfig } from "../config.js";
import type { SandboxBackend } from "../sandbox/types.js";
import type { ToolSpec } from "./types.js";
import { createReadFileTool } from "./readFile.js";
import { createListDirTool } from "./listDir.js";
import { createWriteFileTool } from "./writeFile.js";
import { createEditFileTool } from "./editFile.js";
import { createRunCommandTool } from "./runCommand.js";
import { createUpdateTodosTool } from "./updateTodos.js";

export type { ToolSpec, ToolLevel } from "./types.js";
export type { Todo, TodoStatus } from "./updateTodos.js";

/**
 * 根据配置创建全部工具注册项。
 * @param config 应用配置
 * @param backend 选定的沙箱后端（US-016），供 run_command 包裹命令
 * @returns 带授权级别的工具数组
 */
export function createTools(
  config: AppConfig,
  backend: SandboxBackend,
): ToolSpec[] {
  return [
    createReadFileTool(config),
    createListDirTool(config),
    createWriteFileTool(config),
    createEditFileTool(config),
    createRunCommandTool(config, backend),
    createUpdateTodosTool(),
  ];
}
