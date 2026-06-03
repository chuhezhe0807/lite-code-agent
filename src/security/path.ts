/**
 * 路径安全校验
 *
 * 所有文件类工具（read/write/edit）以及命令执行的路径，都必须先经过这里校验：
 * 把用户/agent 传入的相对或绝对路径解析为绝对路径，再确认它落在工作目录 workdir 之内。
 * 越界路径直接拒绝，防止 agent 读写工作目录之外的敏感文件。
 *
 * 这是「学习级」沙箱的核心防线之一（另一条是命令执行锁定 cwd + 超时）。
 */

import { resolve, relative, isAbsolute } from "node:path";

/** 路径越界时抛出的错误类型，便于上层区分处理 */
export class PathAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathAccessError";
  }
}

/**
 * 把传入路径解析为绝对路径，并校验其位于 workdir 内。
 *
 * @param workdir 允许操作的工作目录（绝对路径）
 * @param inputPath agent 传入的路径，可为相对（相对于 workdir）或绝对
 * @returns 校验通过的绝对路径
 * @throws PathAccessError 当解析后的路径超出 workdir 范围
 */
export function resolveSafePath(workdir: string, inputPath: string): string {
  // 相对路径基于 workdir 解析；绝对路径直接规范化
  const abs = isAbsolute(inputPath)
    ? resolve(inputPath)
    : resolve(workdir, inputPath);

  // 计算相对于 workdir 的路径：若以 ".." 开头或本身是绝对路径，说明跳出了 workdir
  const rel = relative(workdir, abs);
  const escaped = rel.startsWith("..") || isAbsolute(rel);

  if (escaped) {
    throw new PathAccessError(
      `路径越界：'${inputPath}' 解析为 '${abs}'，超出了允许的工作目录 '${workdir}'。`,
    );
  }

  return abs;
}

/**
 * 判断路径是否在 workdir 内（不抛错版本，用于需要布尔判断的场景）。
 */
export function isPathInside(workdir: string, inputPath: string): boolean {
  try {
    resolveSafePath(workdir, inputPath);
    return true;
  } catch {
    return false;
  }
}
