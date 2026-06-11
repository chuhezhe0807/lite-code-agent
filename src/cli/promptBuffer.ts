/**
 * 输入框文本缓冲：纯函数集合
 *
 * 全部以「code point 数组」为单位操作（Array.from），避免在 emoji / 代理对中间
 * 断开。caret 是 code point 下标（0..cells.length）。
 *
 * 折行（wrapLines）与光标定位（locateCaret）用 string-width 计算显示宽度，
 * 因此中日韩 / emoji 等宽字符能落到正确的列。promptInput 用它把硬件光标
 * （ink useCursor）精确停到换行后的真实位置，从而让输入法候选框跟随光标。
 */

import stringWidth from "string-width";

/** 编辑操作统一返回值 */
export interface EditResult {
  text: string;
  caret: number;
}

/** 带 kill 文本的编辑返回值（供 kill-ring 使用） */
export interface KillResult extends EditResult {
  killed: string;
}

/** 可视行（软换行后的一行） */
export interface VisualLine {
  /** 该可视行起始字符在 cells 中的下标 */
  startCaret: number;
  /** 该可视行包含的 cell 数（不含换行符本身） */
  length: number;
  /** 该可视行的显示宽度（不含首行 prefix） */
  width: number;
}

/** 光标在可视布局中的位置 */
export interface CaretPosition {
  row: number;
  col: number;
}

/** 拆成 code point 数组 */
export function toCells(text: string): string[] {
  return Array.from(text);
}

function join(cells: string[]): string {
  return cells.join("");
}

/** 单个 cell 的显示宽度（最小为 0；换行符按 0 处理） */
function cellWidth(cell: string): number {
  if (cell === "\n") return 0;
  return stringWidth(cell);
}

/** 是否为「词」字符（非空白即视为词，便于按词跳转/删除） */
function isWordChar(cell: string | undefined): boolean {
  return cell !== undefined && !/\s/.test(cell);
}

// ─────────────────────────── 编辑 ───────────────────────────

/** 在 caret 处插入字符串 */
export function insert(text: string, caret: number, ins: string): EditResult {
  const cells = toCells(text);
  const insCells = toCells(ins);
  const next = [...cells.slice(0, caret), ...insCells, ...cells.slice(caret)];
  return { text: join(next), caret: caret + insCells.length };
}

/** 删除 caret 前一个字符 */
export function backspaceChar(text: string, caret: number): EditResult {
  if (caret <= 0) return { text, caret };
  const cells = toCells(text);
  const next = [...cells.slice(0, caret - 1), ...cells.slice(caret)];
  return { text: join(next), caret: caret - 1 };
}

/** 删除 caret 处字符（向后删） */
export function deleteChar(text: string, caret: number): EditResult {
  const cells = toCells(text);
  if (caret >= cells.length) return { text, caret };
  const next = [...cells.slice(0, caret), ...cells.slice(caret + 1)];
  return { text: join(next), caret };
}

/** 向前找词首：跳过紧邻空白，再跳过词字符 */
export function wordStartBefore(cells: string[], caret: number): number {
  let i = caret;
  while (i > 0 && !isWordChar(cells[i - 1])) i--;
  while (i > 0 && isWordChar(cells[i - 1])) i--;
  return i;
}

/** 向后找词尾：跳过紧邻空白，再跳过词字符 */
export function wordEndAfter(cells: string[], caret: number): number {
  let i = caret;
  const n = cells.length;
  while (i < n && !isWordChar(cells[i])) i++;
  while (i < n && isWordChar(cells[i])) i++;
  return i;
}

/** 删除 caret 前一个词 */
export function deleteWordBefore(text: string, caret: number): KillResult {
  const cells = toCells(text);
  const start = wordStartBefore(cells, caret);
  const killed = join(cells.slice(start, caret));
  const next = [...cells.slice(0, start), ...cells.slice(caret)];
  return { text: join(next), caret: start, killed };
}

/** 删除 caret 后一个词 */
export function deleteWordAfter(text: string, caret: number): KillResult {
  const cells = toCells(text);
  const end = wordEndAfter(cells, caret);
  const killed = join(cells.slice(caret, end));
  const next = [...cells.slice(0, caret), ...cells.slice(end)];
  return { text: join(next), caret, killed };
}

/** 当前逻辑行（按 \n 切）的起始下标 */
function logicalLineStart(cells: string[], caret: number): number {
  let i = caret;
  while (i > 0 && cells[i - 1] !== "\n") i--;
  return i;
}

/** 当前逻辑行的结束下标（指向 \n 或末尾） */
function logicalLineEnd(cells: string[], caret: number): number {
  let i = caret;
  const n = cells.length;
  while (i < n && cells[i] !== "\n") i++;
  return i;
}

/** 删除到（逻辑）行首；若紧邻 \n 则只删该换行符 */
export function deleteToLineStart(text: string, caret: number): KillResult {
  const cells = toCells(text);
  if (caret > 0 && cells[caret - 1] === "\n") {
    return { ...backspaceChar(text, caret), killed: "\n" };
  }
  const start = logicalLineStart(cells, caret);
  const killed = join(cells.slice(start, caret));
  const next = [...cells.slice(0, start), ...cells.slice(caret)];
  return { text: join(next), caret: start, killed };
}

/** 删除到（逻辑）行尾；若 caret 在 \n 上则只删该换行符 */
export function deleteToLineEnd(text: string, caret: number): KillResult {
  const cells = toCells(text);
  if (cells[caret] === "\n") {
    return { ...deleteChar(text, caret), killed: "\n" };
  }
  const end = logicalLineEnd(cells, caret);
  const killed = join(cells.slice(caret, end));
  const next = [...cells.slice(0, caret), ...cells.slice(end)];
  return { text: join(next), caret, killed };
}

// ─────────────────────────── 移动 ───────────────────────────

export function moveLeft(_text: string, caret: number): number {
  return Math.max(0, caret - 1);
}

export function moveRight(text: string, caret: number): number {
  return Math.min(toCells(text).length, caret + 1);
}

export function moveWordLeft(text: string, caret: number): number {
  return wordStartBefore(toCells(text), caret);
}

export function moveWordRight(text: string, caret: number): number {
  return wordEndAfter(toCells(text), caret);
}

export function moveLineStart(text: string, caret: number): number {
  return logicalLineStart(toCells(text), caret);
}

export function moveLineEnd(text: string, caret: number): number {
  return logicalLineEnd(toCells(text), caret);
}

// ─────────────────────────── 排版 / 折行 ───────────────────────────

/**
 * 把文本按显示宽度折成可视行。
 * 先按显式 \n 切逻辑行，逻辑行内再按 cols 软换行；首个可视行预留 prefixWidth
 * （留给 "> " 之类前缀）。空文本也至少返回一行（便于定位空输入时的光标）。
 */
export function wrapLines(text: string, prefixWidth: number, cols: number): VisualLine[] {
  const cells = toCells(text);
  const usable = Math.max(1, cols);
  const lines: VisualLine[] = [];
  let lineStart = 0; // 当前可视行起点
  let width = 0; // 当前可视行已用显示宽度
  let isFirstVisual = true; // 是否整段的第一可视行（含 prefix）

  const avail = (): number => usable - (isFirstVisual ? prefixWidth : 0);

  const pushLine = (end: number): void => {
    lines.push({ startCaret: lineStart, length: end - lineStart, width });
    lineStart = end;
    width = 0;
    isFirstVisual = false;
  };

  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]!;
    if (cell === "\n") {
      // 换行符结束当前可视行，不计入显示
      pushLine(i);
      lineStart = i + 1; // 跳过 \n 本身
      continue;
    }
    const w = cellWidth(cell);
    if (width + w > avail() && width > 0) {
      // 放不下且当前行非空 → 软换行，当前字符落到下一行
      pushLine(i);
    }
    width += w;
  }
  // 收尾最后一行（即使为空）
  lines.push({ startCaret: lineStart, length: cells.length - lineStart, width });
  return lines;
}

/**
 * 计算 caret 在可视布局中的 {row, col}。
 * col 为该可视行内从行首到 caret 的显示宽度；第 0 行额外加上 prefixWidth。
 */
export function locateCaret(
  text: string,
  caret: number,
  prefixWidth: number,
  cols: number,
): CaretPosition {
  const cells = toCells(text);
  const lines = wrapLines(text, prefixWidth, cols);

  // 找 caret 落在哪一可视行：取「起点 <= caret」的最后一行。
  // caret 恰好等于某行起点时归属该行（行首），但软换行点要归到下一行行首，
  // 显式 \n 后的位置也归到下一行行首 —— 用 startCaret 严格比较即可。
  let row = 0;
  for (let r = 0; r < lines.length; r++) {
    if (caret >= lines[r]!.startCaret) row = r;
    else break;
  }

  const line = lines[row]!;
  let col = row === 0 ? prefixWidth : 0;
  for (let i = line.startCaret; i < caret && i < cells.length; i++) {
    col += cellWidth(cells[i]!);
  }
  return { row, col };
}

/**
 * 跨可视行上移：返回目标 caret；已在首行返回 null（调用方回退到历史导航）。
 * 尽量保持当前列（按显示宽度对齐）。
 */
export function moveUp(text: string, caret: number, prefixWidth: number, cols: number): number | null {
  const pos = locateCaret(text, caret, prefixWidth, cols);
  if (pos.row === 0) return null;
  return caretAtRowCol(text, pos.row - 1, pos.col, prefixWidth, cols);
}

/**
 * 跨可视行下移：返回目标 caret；已在末行返回 null（调用方回退到历史导航）。
 */
export function moveDown(text: string, caret: number, prefixWidth: number, cols: number): number | null {
  const pos = locateCaret(text, caret, prefixWidth, cols);
  const lines = wrapLines(text, prefixWidth, cols);
  if (pos.row >= lines.length - 1) return null;
  return caretAtRowCol(text, pos.row + 1, pos.col, prefixWidth, cols);
}

/** 给定可视行号与目标列（显示宽度），求最接近的 caret 下标 */
function caretAtRowCol(
  text: string,
  row: number,
  targetCol: number,
  prefixWidth: number,
  cols: number,
): number {
  const cells = toCells(text);
  const lines = wrapLines(text, prefixWidth, cols);
  const line = lines[row]!;
  let col = row === 0 ? prefixWidth : 0;
  let i = line.startCaret;
  const end = line.startCaret + line.length;
  while (i < end) {
    const w = cellWidth(cells[i]!);
    if (col + w > targetCol) break;
    col += w;
    i++;
  }
  return i;
}
