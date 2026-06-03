/**
 * edit_file 工具：对工作目录内已有文件做基于 diff 的局部替换（属「写入」级别，需授权）。
 *
 * 设计要点（参考 Claude Code 的 Edit）：
 *   - 用 old_string → new_string 精确替换，比整文件覆盖更安全、改动更可见。
 *   - old_string 必须在文件中「唯一」：找不到或出现多次都报错且不修改，
 *     强制 agent 提供足够上下文，避免改错位置。
 *   - 路径经 resolveSafePath 校验，越界拒绝。
 *   - preview() 用 formatReplaceDiff 展示将要发生的替换，供授权层确认。
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
    .describe("要被替换的原始文本，必须在文件中唯一出现（含足够上下文）"),
  new_string: z.string().describe("替换后的新文本"),
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

/** 读取文件并校验 old_string 唯一性，返回原内容或一个错误字符串 */
async function readAndValidate(
  absPath: string,
  displayPath: string,
  oldString: string,
): Promise<{ text: string } | { error: string }> {
  let text: string;
  try {
    text = await readFile(absPath, "utf-8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return { error: `错误：文件不存在：'${displayPath}'。` };
    if (e.code === "EISDIR") return { error: `错误：'${displayPath}' 是一个目录。` };
    return { error: `错误：读取文件失败：${e.message}` };
  }

  const occurrences = countOccurrences(text, oldString);
  if (occurrences === 0) {
    return { error: `错误：在 '${displayPath}' 中未找到 old_string，未做修改。` };
  }
  if (occurrences > 1) {
    return {
      error: `错误：old_string 在 '${displayPath}' 中出现了 ${occurrences} 次，不唯一。请提供更多上下文以唯一定位，未做修改。`,
    };
  }
  return { text };
}

/**
 * 创建 edit_file 工具。
 * @param config 应用配置（提供 workdir）
 */
export function createEditFileTool(config: AppConfig): ToolSpec {
  const editFileTool = tool(
    async (input): Promise<string> => {
      const { path, old_string, new_string } = input;

      // 1. 路径安全校验
      let absPath: string;
      try {
        absPath = resolveSafePath(config.workdir, path);
      } catch (err) {
        if (err instanceof PathAccessError) return `错误：${err.message}`;
        throw err;
      }

      // 2. 读取并校验 old_string 唯一性
      const res = await readAndValidate(absPath, path, old_string);
      if ("error" in res) return res.error;

      // 3. 执行替换并写回
      const updated = res.text.replace(old_string, new_string);
      try {
        await writeFile(absPath, updated, "utf-8");
      } catch (err) {
        return `错误：写入文件失败：${(err as Error).message}`;
      }

      return `已编辑 '${path}'：替换了 1 处。`;
    },
    {
      name: "edit_file",
      description:
        "对已有文件做局部替换（old_string → new_string）。old_string 必须在文件中唯一出现。需要用户授权。",
      schema,
    },
  );

  /** 授权前预览：展示路径与将要发生的 diff（含唯一性校验提示） */
  const preview: ToolSpec["preview"] = async (args) => {
    const path = String(args.path ?? "");
    const oldString = String(args.old_string ?? "");
    const newString = String(args.new_string ?? "");

    let absPath: string;
    try {
      absPath = resolveSafePath(config.workdir, path);
    } catch (err) {
      if (err instanceof PathAccessError) return `（路径越界，将被拒绝）${err.message}`;
      throw err;
    }

    const diff = formatReplaceDiff(oldString, newString);
    // 预览时顺带提示唯一性问题，让用户在授权前就能发现改不动的情况
    const res = await readAndValidate(absPath, path, oldString);
    const warn = "error" in res ? `\n（注意：${res.error}）` : "";
    return `【编辑文件】${path}\n--- 改动预览 ---\n${diff}${warn}`;
  };

  return { tool: editFileTool, level: "write", preview };
}
