/**
 * 工具注册中心
 *
 * 把所有工具聚合成一个带授权级别的数组。后续故事新增工具（write_file、edit_file、
 * run_command、update_todos）只需在这里 push 一项即可，主循环与授权层无需改动。
 */

import type { AppConfig } from "../config.js";
import type { ToolSpec } from "./types.js";
import { createReadFileTool } from "./readFile.js";
import { createListDirTool } from "./listDir.js";
import { createWriteFileTool } from "./writeFile.js";

export type { ToolSpec, ToolLevel } from "./types.js";

/**
 * 根据配置创建全部工具注册项。
 * @param config 应用配置
 * @returns 带授权级别的工具数组
 */
export function createTools(config: AppConfig): ToolSpec[] {
  return [
    createReadFileTool(config),
    createListDirTool(config),
    createWriteFileTool(config),
    // 后续故事在此追加：edit_file / run_command / update_todos
  ];
}
