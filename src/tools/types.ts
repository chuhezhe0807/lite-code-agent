/**
 * 工具相关的公共类型
 *
 * 每个工具都带一个授权级别（authorization level），决定它在执行前是否需要用户授权：
 *   - read    : 只读操作，默认放行（如 read_file、list_dir）
 *   - write   : 写入操作，需授权（如 write_file、edit_file）
 *   - execute : 执行操作，最高风险，需授权（如 run_command）
 *
 * 工具以「带级别的注册项」形式聚合成数组，便于主循环统一绑定、授权层统一拦截。
 */

import type { StructuredToolInterface } from "@langchain/core/tools";

/** 工具授权级别 */
export type ToolLevel = "read" | "write" | "execute";

/** 工具注册项：工具实例 + 其授权级别 */
export interface ToolSpec {
  tool: StructuredToolInterface;
  level: ToolLevel;
}
