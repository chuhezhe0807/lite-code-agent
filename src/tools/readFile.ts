/**
 * read_file 工具：读取工作目录内文件的内容，支持分页。
 *
 * 设计要点（参考 Claude Code 的 Read）：
 *   - 默认只读前 N 行（config.readFileMaxLines，默认 2000），避免一次性把大文件塞进上下文。
 *   - 支持 offset/limit 分页，让 agent 自己决定读哪一段。
 *   - 内容被截断时，在尾部明确标注剩余行数与续读方式，把翻页控制权交给模型。
 *   - 路径经 resolveSafePath 校验，越界返回可读错误而非抛出未捕获异常。
 */

import { readFile } from "node:fs/promises";
import { z } from "zod";
import { tool } from "@langchain/core/tools";
import type { AppConfig } from "../config.js";
import { resolveSafePath, PathAccessError } from "../security/path.js";
import type { ToolSpec } from "./types.js";

const schema = z.object({
  path: z.string().describe("要读取的文件路径（相对工作目录或绝对路径）"),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("起始行号（0 基），默认从第 0 行开始"),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("最多读取的行数，默认取配置中的上限（如 2000）"),
});

/**
 * 创建 read_file 工具。
 * @param config 应用配置（提供 workdir 与默认读取行数上限）
 */
export function createReadFileTool(config: AppConfig): ToolSpec {
  const readFileTool = tool(
    async (input): Promise<string> => {
      const { path, offset = 0, limit = config.readFileMaxLines } = input;

      // 1. 路径安全校验
      let absPath: string;
      try {
        absPath = resolveSafePath(config.workdir, path);
      } catch (err) {
        if (err instanceof PathAccessError) return `错误：${err.message}`;
        throw err;
      }

      // 2. 读取文件内容
      let text: string;
      try {
        text = await readFile(absPath, "utf-8");
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "ENOENT") return `错误：文件不存在：'${path}'。`;
        if (e.code === "EISDIR")
          return `错误：'${path}' 是一个目录，请用 list_dir 列举。`;
        return `错误：读取文件失败：${e.message}`;
      }

      // 3. 按行分页
      const lines = text.split("\n");
      const total = lines.length;
      const start = Math.min(offset, total);
      const end = Math.min(start + limit, total);
      const slice = lines.slice(start, end).join("\n");

      // 4. 截断标注：若后面还有内容，提示如何续读
      const remaining = total - end;
      if (remaining > 0) {
        return `${slice}\n\n[文件还有 ${remaining} 行未显示，用 offset=${end} 继续读]`;
      }
      return slice;
    },
    {
      name: "read_file",
      description:
        "读取工作目录内文件的文本内容，支持 offset/limit 分页。适合查看代码或配置文件。",
      schema,
    },
  );

  return { tool: readFileTool, level: "read" };
}
