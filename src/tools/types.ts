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

/** 工具注册项：工具实例 + 其授权级别 + 可选的操作预览 */
export interface ToolSpec {
  tool: StructuredToolInterface;
  level: ToolLevel;
  /**
   * 可选：在执行前生成「操作详情」的人类可读描述，供授权层（US-007）展示给用户确认。
   * 例如 write_file/edit_file 返回内容摘要或 diff，run_command 返回完整命令。
   * 只读工具无需提供。
   *
   * @param args 工具调用的入参（与 tool 的 schema 对应）
   */
  preview?: (args: Record<string, unknown>) => string | Promise<string>;
}
