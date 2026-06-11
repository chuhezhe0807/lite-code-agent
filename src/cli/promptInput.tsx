/**
 * 输入行组件
 *
 * 用 ink@7 的 useCursor 把「真实硬件光标」停到编辑位置：终端的中文输入法候选框
 * 跟随的是硬件光标，所以这样候选框就会跟着光标走（不再卡在屏幕底部）。
 *
 * 定位三件套：
 *   - useWindowSize().columns：终端列宽，用于按显示宽度折行。
 *   - useBoxMetrics(ref)：本组件最外层 Box 相对父节点的 {top,left}。只要它是 ink
 *     根 Box 的「直接子节点」，top/left 即等于它在 ink 输出中的绝对行/列，且会随
 *     上方动态内容与终端缩放自动更新。
 *   - promptBuffer.locateCaret：在「手动折行」后的可视布局里算出光标 {row,col}。
 *   最终 setCursorPosition({x: left+col, y: top+row})。
 *
 * 折行由本组件用 promptBuffer.wrapLines 手动完成（把软换行点变成显式 \n 渲染），
 * 因此 locateCaret 与实际渲染严格一致 —— 这正是解决「输入超过一行后光标偏移」的关键。
 *
 * 编辑能力：字符增删、←/→（含按词）、行首/行尾、Ctrl+U/K/W 删除、Ctrl+Y 粘回、
 * Shift/Option+Enter 换行、↑/↓ 在多行内移动（到达首/末行再走历史导航）。
 */

import React, { useRef, useState } from "react";
import { Box, Text, useInput, useCursor, useBoxMetrics, useWindowSize, type DOMElement } from "ink";
import stringWidth from "string-width";
import * as buf from "./promptBuffer.js";

export interface PromptInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder?: string;
  /** 历史记录，旧 → 新 */
  history: string[];
  /** 仅在 idle 阶段为 true：激活文本编辑与历史导航 */
  isActive: boolean;
}

const PROMPT = "> ";
const PREFIX_WIDTH = stringWidth(PROMPT);

function PromptInput({
  value,
  onChange,
  onSubmit,
  placeholder = "",
  history,
  isActive,
}: PromptInputProps): React.ReactElement {
  // 光标位置（code point 下标）
  const [caret, setCaret] = useState(buf.toCells(value).length);
  // 用于检测「外部改变 value」（历史回填/程序化）以重置光标到末尾
  const lastValueRef = useRef(value);
  // 历史导航：-1 表示当前草稿
  const historyIndexRef = useRef(-1);
  const draftRef = useRef("");
  // kill-ring：最近一次 Ctrl+U/K/W 删除的文本，供 Ctrl+Y 粘回
  const killRingRef = useRef("");

  const ref = useRef<DOMElement | null>(null);
  const { top, left, hasMeasured } = useBoxMetrics(ref);
  const { columns } = useWindowSize();
  const { setCursorPosition } = useCursor();

  const cols = columns || 80;

  // 外部改变了 value（且不是本组件刚提交的编辑）→ 光标移到末尾
  if (value !== lastValueRef.current) {
    lastValueRef.current = value;
    const end = buf.toCells(value).length;
    if (caret !== end) setCaret(end);
  }

  // 提交一次文本编辑：同步 value 与 caret，并标记 lastValue 避免被当成外部变更
  const apply = (next: { text: string; caret: number }): void => {
    lastValueRef.current = next.text;
    historyIndexRef.current = -1; // 手动编辑即退出历史导航
    if (next.text !== value) onChange(next.text);
    setCaret(next.caret);
  };

  // 仅移动光标（不改文本）
  const moveCaret = (next: number): void => {
    setCaret(next);
  };

  const kill = (r: buf.KillResult): void => {
    if (r.killed) killRingRef.current = r.killed;
    apply(r);
  };

  // ↑：回填更旧历史；越过首条则停。返回是否已处理。
  const historyUp = (): void => {
    if (history.length === 0) return;
    if (historyIndexRef.current === -1) {
      draftRef.current = value;
      historyIndexRef.current = history.length - 1;
    } else {
      historyIndexRef.current = Math.max(0, historyIndexRef.current - 1);
    }
    const v = history[historyIndexRef.current]!;
    lastValueRef.current = v;
    onChange(v);
    setCaret(buf.toCells(v).length);
  };

  // ↓：回填更新历史；越过最新则恢复草稿。
  const historyDown = (): void => {
    if (historyIndexRef.current === -1) return;
    historyIndexRef.current += 1;
    let v: string;
    if (historyIndexRef.current >= history.length) {
      historyIndexRef.current = -1;
      v = draftRef.current;
    } else {
      v = history[historyIndexRef.current]!;
    }
    lastValueRef.current = v;
    onChange(v);
    setCaret(buf.toCells(v).length);
  };

  useInput(
    (input, key) => {
      // 回车：Shift/Option+Enter 换行，否则提交
      if (key.return) {
        if (key.shift || key.meta) {
          apply(buf.insert(value, caret, "\n"));
        } else {
          onSubmit(value);
        }
        return;
      }

      // 方向键
      if (key.leftArrow) {
        moveCaret(key.ctrl || key.meta ? buf.moveWordLeft(value, caret) : buf.moveLeft(value, caret));
        return;
      }
      if (key.rightArrow) {
        moveCaret(key.ctrl || key.meta ? buf.moveWordRight(value, caret) : buf.moveRight(value, caret));
        return;
      }
      if (key.upArrow) {
        const next = buf.moveUp(value, caret, PREFIX_WIDTH, cols);
        if (next === null) historyUp();
        else moveCaret(next);
        return;
      }
      if (key.downArrow) {
        const next = buf.moveDown(value, caret, PREFIX_WIDTH, cols);
        if (next === null) historyDown();
        else moveCaret(next);
        return;
      }

      // 行首 / 行尾
      if (key.home || (key.ctrl && input === "a")) {
        moveCaret(buf.moveLineStart(value, caret));
        return;
      }
      if (key.end || (key.ctrl && input === "e")) {
        moveCaret(buf.moveLineEnd(value, caret));
        return;
      }

      // 删除
      if (key.backspace) {
        if (key.ctrl || key.meta) kill(buf.deleteWordBefore(value, caret));
        else apply(buf.backspaceChar(value, caret));
        return;
      }
      if (key.delete) {
        if (key.meta) kill(buf.deleteToLineEnd(value, caret));
        else apply(buf.deleteChar(value, caret));
        return;
      }

      // Emacs 风格删除 / 粘回
      if (key.ctrl && input === "u") {
        kill(buf.deleteToLineStart(value, caret));
        return;
      }
      if (key.ctrl && input === "k") {
        kill(buf.deleteToLineEnd(value, caret));
        return;
      }
      if (key.ctrl && input === "w") {
        kill(buf.deleteWordBefore(value, caret));
        return;
      }
      if (key.ctrl && input === "y") {
        if (killRingRef.current) apply(buf.insert(value, caret, killRingRef.current));
        return;
      }

      // 可打印字符（含粘贴的多字符）。过滤控制键组合。
      if (input && !key.ctrl && !key.meta) {
        apply(buf.insert(value, caret, input));
      }
    },
    { isActive },
  );

  // ── 渲染：把折行结果用显式 \n 拼成单个 Text；首行带彩色前缀 ──
  const lines = buf.wrapLines(value, PREFIX_WIDTH, cols);
  const cells = buf.toCells(value);
  const rendered = lines
    .map((l) => cells.slice(l.startCaret, l.startCaret + l.length).join(""))
    .join("\n");

  const showPlaceholder = value.length === 0 && placeholder.length > 0;

  // 设置硬件光标位置（渲染期调用，useCursor 内部在提交期生效）
  const pos = buf.locateCaret(value, caret, PREFIX_WIDTH, cols);
  if (isActive && hasMeasured) {
    setCursorPosition({ x: left + pos.col, y: top + pos.row });
  } else {
    setCursorPosition(undefined);
  }

  return (
    <Box ref={ref} marginTop={1}>
      <Text>
        <Text color="cyan">{PROMPT}</Text>
        {showPlaceholder ? <Text dimColor>{placeholder}</Text> : rendered}
      </Text>
    </Box>
  );
}

export default PromptInput;
