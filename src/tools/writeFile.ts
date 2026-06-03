/**
 * write_file 工具：在工作目录内创建或整体覆盖一个文件（属「写入」级别，需授权）。
 *
 * 设计要点：
 *   - 路径经 resolveSafePath 校验，越界直接拒绝。
 *   - 自动创建缺失的父目录（父目录必然也在 workdir 内）。
 *   - 区分「新建」与「覆盖」并在返回中说明行数变化，便于 agent 与用户确认结果。
 *   - 提供 preview()：在授权前向用户展示路径 + 新建/覆盖 + 内容摘要（前若干行）。
 *     真正的「询问—等待」交互由 US-007 授权层调用 preview 实现，本工具只负责执行。
 */

import { readFile, writeFile as fsWriteFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { tool } from "@langchain/core/tools";
import type { AppConfig } from "../config.js";
import { resolveSafePath, PathAccessError } from "../security/path.js";
import type { ToolSpec } from "./types.js";

/** preview 中内容摘要最多展示的行数 */
const PREVIEW_MAX_LINES = 50;

const schema = z.object({
  path: z.string().describe("要写入的文件路径（相对工作目录或绝对路径）"),
  content: z.string().describe("要写入文件的完整文本内容（会整体覆盖原文件）"),
});

/** 统计文本行数（空串视为 0 行） */
function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split("\n").length;
}

/** 把内容截断到前 N 行用于预览 */
function truncateForPreview(content: string): string {
  const lines = content.split("\n");
  if (lines.length <= PREVIEW_MAX_LINES) return content;
  return (
    lines.slice(0, PREVIEW_MAX_LINES).join("\n") +
    `\n... [共 ${lines.length} 行，仅预览前 ${PREVIEW_MAX_LINES} 行]`
  );
}

/**
 * 创建 write_file 工具。
 * @param config 应用配置（提供 workdir）
 */
export function createWriteFileTool(config: AppConfig): ToolSpec {
  const writeFileTool = tool(
    async (input): Promise<string> => {
      const { path, content } = input;

      // 1. 路径安全校验
      let absPath: string;
      try {
        absPath = resolveSafePath(config.workdir, path);
      } catch (err) {
        if (err instanceof PathAccessError) return `错误：${err.message}`;
        throw err;
      }

      // 2. 判断是新建还是覆盖（用于结果说明）
      const existed = existsSync(absPath);
      let oldLines = 0;
      if (existed) {
        try {
          oldLines = countLines(await readFile(absPath, "utf-8"));
        } catch {
          // 读旧内容失败不影响写入，仅无法报告原行数
        }
      }

      // 3. 自动创建父目录后写入
      try {
        await mkdir(dirname(absPath), { recursive: true });
        await fsWriteFile(absPath, content, "utf-8");
      } catch (err) {
        return `错误：写入文件失败：${(err as Error).message}`;
      }

      const newLines = countLines(content);
      return existed
        ? `已覆盖 '${path}'（原 ${oldLines} 行 → 新 ${newLines} 行）。`
        : `已新建 '${path}'（${newLines} 行）。`;
    },
    {
      name: "write_file",
      description:
        "在工作目录内创建或整体覆盖一个文件。需要用户授权。用于写入新文件或完全重写已有文件。",
      schema,
    },
  );

  /** 授权前预览：展示路径、新建/覆盖、内容摘要 */
  const preview: ToolSpec["preview"] = async (args) => {
    const path = String(args.path ?? "");
    const content = String(args.content ?? "");
    let absPath: string;
    try {
      absPath = resolveSafePath(config.workdir, path);
    } catch (err) {
      if (err instanceof PathAccessError) return `（路径越界，将被拒绝）${err.message}`;
      throw err;
    }
    const action = existsSync(absPath) ? "覆盖" : "新建";
    return `【${action}文件】${path}\n--- 内容预览 ---\n${truncateForPreview(content)}`;
  };

  return { tool: writeFileTool, level: "write", preview };
}
