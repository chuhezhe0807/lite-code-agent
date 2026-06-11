/**
 * grep 工具：在工作目录内按正则搜索文件内容（只读，默认放行）。
 *
 * 设计要点（参考 Claude Code 的 Grep）：
 *   - 命中以 `文件:行号:行内容` 形式返回，行号 1 基。
 *   - path 限定搜索子目录（默认工作目录根）；include 按文件名 glob 过滤（如 *.ts）。
 *   - 搜索根经 resolveSafePath 白名单校验，越界拒绝。
 *   - 默认跳过噪音目录（见 walkFiles）与疑似二进制文件（含 NUL 字节）。
 *   - 命中过多时截断并提示缩小范围；非法正则返回可读错误，不崩溃。
 *   - 无文件副作用，level=read。
 */

import { readFile } from "node:fs/promises";
import { z } from "zod";
import { tool } from "@langchain/core/tools";
import type { AppConfig } from "../config.js";
import { resolveSafePath, PathAccessError } from "../security/path.js";
import { createGlobMatcher, walkFiles, relPosix } from "../util/glob.js";
import type { ToolSpec } from "./types.js";

/** 单次最多返回的命中行数，超出则截断并提示 */
const MAX_MATCHES = 50;
/** 单文件最大读取字节，超过视为大文件跳过，避免内存压力 */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** 单行展示的最大字符数，超长截断避免输出爆炸 */
const MAX_LINE_CHARS = 300;

const schema = z.object({
  pattern: z.string().describe("要搜索的正则表达式，如 'createTools' 或 'function\\\\s+\\\\w+'"),
  path: z
    .string()
    .optional()
    .describe("搜索根目录（相对工作目录或绝对路径），默认为工作目录根 '.'"),
  include: z
    .string()
    .optional()
    .describe("按文件名 glob 过滤要搜索的文件，如 '*.ts'、'**/*.tsx'；省略则搜索全部"),
});

/** 判断 Buffer 是否疑似二进制（含 NUL 字节） */
function looksBinary(buf: Buffer): boolean {
  // 只看前 8KB 即可判定，避免扫整个大文件
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * 创建 grep 工具。
 * @param config 应用配置（提供 workdir）
 */
export function createGrepTool(config: AppConfig): ToolSpec {
  const grepTool = tool(
    async (input, runnableConfig): Promise<string> => {
      const { pattern, path = ".", include } = input;
      const signal = runnableConfig?.signal;

      // 1. 编译正则（非法正则给可读错误，不崩溃）
      let regex: RegExp;
      try {
        regex = new RegExp(pattern);
      } catch (err) {
        return `错误：非法正则表达式：${(err as Error).message}`;
      }

      // 2. 搜索根路径安全校验
      let absRoot: string;
      try {
        absRoot = resolveSafePath(config.workdir, path);
      } catch (err) {
        if (err instanceof PathAccessError) return `错误：${err.message}`;
        throw err;
      }

      const includeMatcher = include ? createGlobMatcher(include) : null;
      const hits: string[] = [];
      let truncated = false;

      // 3. 遍历文件并逐行匹配
      try {
        outer: for await (const abs of walkFiles(absRoot)) {
          if (signal?.aborted) break;
          // include 过滤按「相对搜索根」的路径判定
          if (includeMatcher && !includeMatcher(relPosix(absRoot, abs))) continue;

          let buf: Buffer;
          try {
            buf = await readFile(abs);
          } catch {
            continue; // 单文件读取失败跳过，不影响整体
          }
          if (buf.length > MAX_FILE_BYTES || looksBinary(buf)) continue;

          const display = relPosix(config.workdir, abs);
          const lines = buf.toString("utf-8").split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (!regex.test(lines[i])) continue;
            let text = lines[i];
            if (text.length > MAX_LINE_CHARS) {
              text = text.slice(0, MAX_LINE_CHARS) + "…[行过长已截断]";
            }
            hits.push(`${display}:${i + 1}:${text}`);
            if (hits.length > MAX_MATCHES) {
              truncated = true;
              break outer;
            }
          }
        }
      } catch (err) {
        return `错误：搜索失败：${(err as Error).message}`;
      }

      if (hits.length === 0) {
        const scope = include ? `（include='${include}'）` : "";
        return `（无匹配：在 '${path}' 下未找到匹配 /${pattern}/ 的内容${scope}）`;
      }

      if (truncated) {
        const shown = hits.slice(0, MAX_MATCHES).join("\n");
        return `${shown}\n\n[命中过多，仅显示前 ${MAX_MATCHES} 条，请用更具体的 pattern、path 或 include 缩小范围]`;
      }
      return hits.join("\n");
    },
    {
      name: "grep",
      description:
        "在工作目录内按正则搜索文件内容，命中以 文件:行号:行内容 返回。可用 path 限定子目录、include 按文件名过滤（如 *.ts）。用于快速定位符号/关键字。",
      schema,
    },
  );

  return { tool: grepTool, level: "read" };
}
