/**
 * 输入历史（.litecode/history.json）的读写
 *
 * 把用户在输入行提交过的内容持久化到磁盘，供下次（含跨会话）用 ↑/↓ 方向键回填。
 * 读写范式对齐 src/permissions/settings.ts：文件缺失或损坏时回退到空列表，绝不抛错阻塞启动。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 历史文件名 */
const HISTORY_FILE = "history.json";

/** 历史最多保留的条数（保留最近的，超出丢弃最旧的） */
const MAX_HISTORY = 200;

/** 计算历史文件的绝对路径 */
export function historyPath(litecodeDir: string): string {
  return join(litecodeDir, HISTORY_FILE);
}

/**
 * 加载输入历史（旧 → 新）。文件不存在或解析失败时返回空数组。
 * @param litecodeDir .litecode 目录绝对路径
 */
export function loadHistory(litecodeDir: string): string[] {
  const path = historyPath(litecodeDir);
  if (!existsSync(path)) {
    return [];
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

/**
 * 追加一条历史并持久化，返回更新后的列表（旧 → 新）。
 * 与最后一条完全相同则跳过（去重连续重复），并截断到最近 MAX_HISTORY 条。
 * @param litecodeDir .litecode 目录绝对路径
 * @param entry 要追加的输入内容
 */
export function appendHistory(litecodeDir: string, entry: string): string[] {
  const list = loadHistory(litecodeDir);
  if (list.length > 0 && list[list.length - 1] === entry) {
    return list;
  }
  list.push(entry);
  const trimmed = list.slice(-MAX_HISTORY);
  try {
    writeFileSync(historyPath(litecodeDir), JSON.stringify(trimmed, null, 2), "utf-8");
  } catch {
    // 写盘失败不影响本次会话内的历史使用
  }
  return trimmed;
}
