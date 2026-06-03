/**
 * list_dir 工具：列举工作目录内某个目录下的文件与子目录。
 *
 * 设计要点：
 *   - 子目录名后加 "/" 以区分文件与目录。
 *   - 条目过多时只返回前 N 条 + 总数，并提示用更具体的路径，避免输出爆炸。
 *   - 路径经 resolveSafePath 校验，越界返回可读错误。
 */

import { readdir } from "node:fs/promises";
import { z } from "zod";
import { tool } from "@langchain/core/tools";
import type { AppConfig } from "../config.js";
import { resolveSafePath, PathAccessError } from "../security/path.js";
import type { ToolSpec } from "./types.js";

/** 单次最多列举的条目数，超出则截断并提示 */
const MAX_ENTRIES = 200;

const schema = z.object({
  path: z
    .string()
    .optional()
    .describe("要列举的目录路径（相对工作目录或绝对路径），默认为工作目录根 '.'"),
});

/**
 * 创建 list_dir 工具。
 * @param config 应用配置（提供 workdir）
 */
export function createListDirTool(config: AppConfig): ToolSpec {
  const listDirTool = tool(
    async (input): Promise<string> => {
      const path = input.path ?? ".";

      // 1. 路径安全校验
      let absPath: string;
      try {
        absPath = resolveSafePath(config.workdir, path);
      } catch (err) {
        if (err instanceof PathAccessError) return `错误：${err.message}`;
        throw err;
      }

      // 2. 读取目录项（withFileTypes 以便区分文件/目录）
      let entries;
      try {
        entries = await readdir(absPath, { withFileTypes: true });
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "ENOENT") return `错误：目录不存在：'${path}'。`;
        if (e.code === "ENOTDIR")
          return `错误：'${path}' 不是目录，请用 read_file 读取。`;
        return `错误：列举目录失败：${e.message}`;
      }

      // 3. 目录在前、文件在后，各自按名称排序；目录名加 "/"
      const names = entries
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort((a, b) => {
          const aDir = a.endsWith("/");
          const bDir = b.endsWith("/");
          if (aDir !== bDir) return aDir ? -1 : 1;
          return a.localeCompare(b);
        });

      if (names.length === 0) return `（空目录：'${path}'）`;

      // 4. 条目过多时截断
      if (names.length > MAX_ENTRIES) {
        const shown = names.slice(0, MAX_ENTRIES).join("\n");
        return `${shown}\n\n[共 ${names.length} 项，仅显示前 ${MAX_ENTRIES} 项，请使用更具体的子路径缩小范围]`;
      }

      return names.join("\n");
    },
    {
      name: "list_dir",
      description:
        "列举工作目录内某个目录下的文件与子目录（子目录名以 / 结尾）。用于了解项目结构。",
      schema,
    },
  );

  return { tool: listDirTool, level: "read" };
}
