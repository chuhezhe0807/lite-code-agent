/**
 * 授权规则的解析、匹配与泛化
 *
 * 规则字符串格式：`工具名(参数模式)`，例如：
 *   - read_file(*)            匹配 read_file 的任意参数
 *   - write_file(src/*)       匹配 write_file 写入 src/ 下的路径
 *   - run_command(npx tsc *)  匹配以 "npx tsc " 开头的命令
 *
 * 参数模式中的 `*` 是通配符，匹配任意字符（包括空）。其余字符按字面匹配。
 */

import { dirname } from "node:path";
import type { ToolLevel } from "../tools/types.js";

/** 解析后的规则 */
export interface ParsedRule {
  toolName: string;
  pattern: string;
}

/**
 * 解析规则字符串 `工具名(模式)`。
 * @returns 解析结果；格式非法时返回 null
 */
export function parseRule(rule: string): ParsedRule | null {
  const m = /^([^(]+)\((.*)\)$/.exec(rule.trim());
  if (!m) return null;
  return { toolName: m[1].trim(), pattern: m[2] };
}

/**
 * 把含 `*` 的模式编译为正则并对 target 做整体匹配。
 * 除 `*` 外的正则元字符都会被转义，确保按字面匹配。
 */
export function matchPattern(pattern: string, target: string): boolean {
  // 转义正则特殊字符，再把 \* 还原为 .*
  const escaped = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\\\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(target);
}

/**
 * 判断给定工具调用是否命中规则列表中的任意一条。
 *
 * @param rules 规则字符串数组
 * @param toolName 当前工具名
 * @param target 当前调用的「权限目标」（命令串或路径，见 manager.ts）
 */
export function matchesAny(
  rules: string[],
  toolName: string,
  target: string,
): boolean {
  for (const rule of rules) {
    const parsed = parseRule(rule);
    if (!parsed) continue;
    if (parsed.toolName === toolName && matchPattern(parsed.pattern, target)) {
      return true;
    }
  }
  return false;
}

/**
 * 把一次具体调用泛化为一条可复用规则（供「始终允许/拒绝」使用）。
 *
 * 泛化策略（初版，简单可预测）：
 *   - execute 级（命令）：取命令首段（首个 token，若第二个 token 不是选项则一并保留）+ " *"。
 *       npx tsc --noEmit  → run_command(npx tsc *)
 *       git commit -m x   → run_command(git commit *)
 *       ls                → run_command(ls *)
 *   - write 级（路径）：取所在目录 + "/*"；位于根则用 "*"。
 *       src/a/b.ts → write_file(src/a/*)
 *       foo.ts     → write_file(*)
 *
 * 生成的规则文本会在写入前交给用户确认（见 manager.ts）。
 */
export function generalizeRule(
  toolName: string,
  level: ToolLevel,
  target: string,
): string {
  if (level === "execute") {
    const tokens = target.trim().split(/\s+/).filter(Boolean);
    let base = tokens[0] ?? "";
    if (tokens[1] && !tokens[1].startsWith("-")) {
      base += ` ${tokens[1]}`;
    }
    return `${toolName}(${base} *)`;
  }
  // write 级按目录泛化
  const dir = dirname(target);
  const pat = dir === "." || dir === "" ? "*" : `${dir}/*`;
  return `${toolName}(${pat})`;
}
