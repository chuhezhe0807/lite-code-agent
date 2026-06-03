/**
 * 简易 diff 格式化
 *
 * 用于在 edit_file 授权前向用户展示「将把哪段文本替换为哪段文本」。
 * 这里不做复杂的 LCS 行级对齐——edit_file 的改动本就是一段 old_string → new_string，
 * 直接把旧文本逐行加 "- " 前缀、新文本逐行加 "+ " 前缀即可清晰表达。
 */

/**
 * 把一次「文本替换」格式化为带 -/+ 前缀的可读 diff。
 *
 * @param oldText 被替换掉的原文本
 * @param newText 替换后的新文本
 * @returns 形如：
 *   - 旧的第一行
 *   - 旧的第二行
 *   + 新的第一行
 */
export function formatReplaceDiff(oldText: string, newText: string): string {
  const minus = oldText
    .split("\n")
    .map((line) => `- ${line}`)
    .join("\n");
  const plus = newText
    .split("\n")
    .map((line) => `+ ${line}`)
    .join("\n");
  return `${minus}\n${plus}`;
}
