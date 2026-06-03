/**
 * edit_file 工具：对工作目录内已有文件做基于 diff 的局部替换（属「写入」级别，需授权）。
 *
 * 设计哲学（参考 Claude Code 的 Edit）：
 *   - 默认要求 old_string 在文件中「唯一」。这不是缺陷而是安全特性：当出现多个相同片段时，
 *     宁可报错让模型补充上下文，也不要猜着改错地方。
 *   - 「文件里有多处相同、但只想改某一处」的正解是：在 old_string 里带上周围几行上下文，
 *     使其唯一，而不是按行号/序号定位（那些方式更脆弱）。
 *   - 「要改全部相同处」（如重命名变量）的正解是：设置 replace_all=true。
 *   - 路径经 resolveSafePath 校验，越界拒绝；preview 展示 diff 供授权确认。
 */

import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { tool } from "@langchain/core/tools";
import type { AppConfig } from "../config.js";
import { resolveSafePath, PathAccessError } from "../security/path.js";
import { formatReplaceDiff } from "../util/diff.js";
import type { ToolSpec } from "./types.js";

const schema = z.object({
  path: z.string().describe("要编辑的文件路径（相对工作目录或绝对路径）"),
  old_string: z
    .string()
    .describe(
      "要被替换的原始文本。默认须在文件中唯一出现；若文件中有多处相同片段而只想改其一，请在此带上周围上下文使其唯一。",
    ),
  new_string: z.string().describe("替换后的新文本"),
  replace_all: z
    .boolean()
    .optional()
    .describe("是否替换全部相同片段（用于重命名等场景）。默认 false，只替换唯一的一处。"),
});

/** 统计 needle 在 haystack 中出现的次数 */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/**
 * 读取文件并按 replaceAll 模式校验 old_string。
 * @returns 成功返回 { text, count }（count 为匹配次数）；否则返回 { error }
 */
async function readAndValidate(
  absPath: string,
  displayPath: string,
  oldString: string,
  replaceAll: boolean,
): Promise<{ text: string; count: number } | { error: string }> {
  let text: string;
  try {
    text = await readFile(absPath, "utf-8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return { error: `错误：文件不存在：'${displayPath}'。` };
    if (e.code === "EISDIR") return { error: `错误：'${displayPath}' 是一个目录。` };
    return { error: `错误：读取文件失败：${e.message}` };
  }

  const count = countOccurrences(text, oldString);
  if (count === 0) {
    return { error: `错误：在 '${displayPath}' 中未找到 old_string，未做修改。` };
  }
  if (count > 1 && !replaceAll) {
    return {
      error:
        `错误：old_string 在 '${displayPath}' 中出现了 ${count} 次，不唯一，未做修改。` +
        `若只想改其中一处，请在 old_string 中带上周围上下文使其唯一；` +
        `若想全部替换，请设置 replace_all=true。`,
    };
  }
  return { text, count };
}

/**
 * 创建 edit_file 工具。
 * @param config 应用配置（提供 workdir）
 */
export function createEditFileTool(config: AppConfig): ToolSpec {
  const editFileTool = tool(
    async (input): Promise<string> => {
      const { path, old_string, new_string } = input;
      const replaceAll = input.replace_all ?? false;

      // 1. 路径安全校验
      let absPath: string;
      try {
        absPath = resolveSafePath(config.workdir, path);
      } catch (err) {
        if (err instanceof PathAccessError) return `错误：${err.message}`;
        throw err;
      }

      // 2. 读取并按模式校验
      const res = await readAndValidate(absPath, path, old_string, replaceAll);
      if ("error" in res) return res.error;

      // 3. 执行替换并写回（replaceAll 用 split/join 做字面量全替换）
      const updated = replaceAll
        ? res.text.split(old_string).join(new_string)
        : res.text.replace(old_string, new_string);
      try {
        await writeFile(absPath, updated, "utf-8");
      } catch (err) {
        return `错误：写入文件失败：${(err as Error).message}`;
      }

      return replaceAll
        ? `已编辑 '${path}'：替换了全部 ${res.count} 处。`
        : `已编辑 '${path}'：替换了 1 处。`;
    },
    {
      name: "edit_file",
      description:
        "对已有文件做局部替换（old_string → new_string）。默认 old_string 须唯一（多处相同时请带上下文使其唯一）；设 replace_all=true 可替换全部。需要用户授权。",
      schema,
    },
  );

  /** 授权前预览：展示路径、替换范围与 diff（含校验提示） */
  const preview: ToolSpec["preview"] = async (args) => {
    const path = String(args.path ?? "");
    const oldString = String(args.old_string ?? "");
    const newString = String(args.new_string ?? "");
    const replaceAll = Boolean(args.replace_all);

    let absPath: string;
    try {
      absPath = resolveSafePath(config.workdir, path);
    } catch (err) {
      if (err instanceof PathAccessError) return `（路径越界，将被拒绝）${err.message}`;
      throw err;
    }

    const diff = formatReplaceDiff(oldString, newString);
    const res = await readAndValidate(absPath, path, oldString, replaceAll);
    const scope =
      "count" in res && replaceAll ? `（替换全部 ${res.count} 处）` : "";
    const warn = "error" in res ? `\n（注意：${res.error}）` : "";
    return `【编辑文件】${path}${scope}\n--- 改动预览 ---\n${diff}${warn}`;
  };

  return { tool: editFileTool, level: "write", preview };
}
