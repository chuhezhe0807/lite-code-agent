/**
 * glob 工具：在工作目录内按文件名模式递归查找文件（只读，默认放行）。
 *
 * 设计要点（参考 Claude Code 的 Glob）：
 *   - 支持 ** / * / ? 模式，如 `**\/*.ts`、`src/**\/*.tsx`、`*.json`。
 *   - 搜索根可选（path），默认工作目录根；经 resolveSafePath 白名单校验，越界拒绝。
 *   - 默认跳过噪音目录（node_modules/.git/dist，见 walkFiles）。
 *   - 结果按路径排序；过多时截断并提示缩小范围；无匹配明确提示。
 *   - 无文件副作用，level=read。
 */

import { z } from "zod";
import { tool } from "@langchain/core/tools";
import type { AppConfig } from "../config.js";
import { resolveSafePath, PathAccessError } from "../security/path.js";
import { createGlobMatcher, walkFiles, relPosix } from "../util/glob.js";
import type { ToolSpec } from "./types.js";

/** 单次最多返回的匹配文件数，超出则截断并提示 */
const MAX_RESULTS = 100;

const schema = z.object({
  pattern: z
    .string()
    .describe(
      "文件名 glob 模式，如 '**/*.ts'、'src/**/*.tsx'、'*.json'（不含 / 时按文件名匹配任意层级）",
    ),
  path: z
    .string()
    .optional()
    .describe("搜索根目录（相对工作目录或绝对路径），默认为工作目录根 '.'"),
});

/**
 * 创建 glob 工具。
 * @param config 应用配置（提供 workdir）
 */
export function createGlobTool(config: AppConfig): ToolSpec {
  const globTool = tool(
    async (input, runnableConfig): Promise<string> => {
      const { pattern, path = "." } = input;
      const signal = runnableConfig?.signal;

      // 1. 搜索根路径安全校验
      let absRoot: string;
      try {
        absRoot = resolveSafePath(config.workdir, path);
      } catch (err) {
        if (err instanceof PathAccessError) return `错误：${err.message}`;
        throw err;
      }

      // 2. 编译匹配器并遍历
      const matches = createGlobMatcher(pattern);
      const found: string[] = [];
      let truncated = false;
      try {
        for await (const abs of walkFiles(absRoot)) {
          if (signal?.aborted) break;
          // 匹配按「相对搜索根」的路径判定（与用户写的 pattern 直觉一致）
          if (!matches(relPosix(absRoot, abs))) continue;
          // 展示用「相对工作目录」的路径，便于 agent 直接拿去 read_file
          found.push(relPosix(config.workdir, abs));
          if (found.length > MAX_RESULTS) {
            truncated = true;
            break;
          }
        }
      } catch (err) {
        return `错误：查找文件失败：${(err as Error).message}`;
      }

      if (found.length === 0) {
        return `（无匹配：在 '${path}' 下未找到匹配 '${pattern}' 的文件）`;
      }

      found.sort((a, b) => a.localeCompare(b));
      if (truncated) {
        const shown = found.slice(0, MAX_RESULTS).join("\n");
        return `${shown}\n\n[匹配过多，仅显示前 ${MAX_RESULTS} 个，请用更具体的 pattern 或 path 缩小范围]`;
      }
      return found.join("\n");
    },
    {
      name: "glob",
      description:
        "在工作目录内按文件名 glob 模式（如 **/*.ts、src/**/*.tsx）递归查找文件，返回匹配的文件路径列表。用于快速定位文件。",
      schema,
    },
  );

  return { tool: globTool, level: "read" };
}
