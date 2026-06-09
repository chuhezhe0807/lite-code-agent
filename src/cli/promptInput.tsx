/**
 * 自定义输入行组件（替代 ink-text-input）
 *
 * 相比 ink-text-input 多做两件事：
 *   1. ↑/↓ 方向键在历史记录中回填上一条/下一条输入（回填后光标置于行尾）。
 *   2. 把「真实终端硬件光标」移动到逻辑光标处，使中文输入法（拼音）的候选字列表
 *      跟随可见光标弹出，而不是停在屏幕底部。
 *
 * 第 2 点是 best-effort：假设输入行单行不换行；终端会在每帧后把硬件光标停在
 * 「最后一行内容的下一行、第 0 列」这个 anchor，故输入行恰在其上方 1 行。
 * 我们在渲染后把光标上移到 caret，并在下次按键处理的最开头把光标停回 anchor，
 * 以免与 Ink 的增量擦除（eraseLines 从当前光标向上擦）冲突。
 */

import React, { useEffect, useRef, useState } from "react";
import { Text, useInput, useStdout } from "ink";
import stringWidth from "string-width";

const ESC = "\x1b";

/** 输入行恰在 anchor（帧末尾光标停留行）上方的行数；单行不换行假设下为 1 */
const ROWS_BELOW_INPUT = 1;

export interface PromptInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder?: string;
  /** 历史记录，旧 → 新 */
  history: string[];
  /** 仅在 idle 阶段为 true：激活按键监听与真实光标定位 */
  isActive: boolean;
  /** 父组件渲染的提示符显示宽度（"> " 为 2），用于计算光标列 */
  promptWidth?: number;
}

/** 把真实光标移到 caret 并显示它（供 IME 候选框定位） */
function moveCursorToCaret(stdout: NodeJS.WriteStream, col: number): void {
  stdout.write(`${ESC}[?25h${ESC}[${ROWS_BELOW_INPUT}A${ESC}[${col}G`);
}

/** 把真实光标停回帧末尾 anchor，避免影响 Ink 下一帧的增量擦除 */
function parkCursor(stdout: NodeJS.WriteStream): void {
  stdout.write(`${ESC}[${ROWS_BELOW_INPUT}B${ESC}[G`);
}

function PromptInput({
  value,
  onChange,
  onSubmit,
  placeholder = "",
  history,
  isActive,
  promptWidth = 2,
}: PromptInputProps): React.ReactElement {
  const { stdout } = useStdout();
  const [cursorOffset, setCursorOffset] = useState(value.length);
  // 每次按键自增，强制「移动真实光标」的 effect 重跑——
  // 即使本次按键不改变 value/cursorOffset（如 Tab、边界方向键、空历史导航），
  // 也能把上一步停回 anchor 的光标重新移回 caret，避免它卡在左下角。
  const [tick, setTick] = useState(0);
  // -1 表示「当前草稿」，未进入历史导航
  const historyIndexRef = useRef(-1);
  // 进入历史导航前暂存的草稿，用于 ↓ 越过最新条目时恢复
  const draftRef = useRef("");
  // 真实光标当前是否已被移到 caret（仅在为 true 时才需要 park）
  const cursorMovedRef = useRef(false);

  // value 外部变短（如提交后被清空）时夹住光标，避免越界
  useEffect(() => {
    setCursorOffset((prev) => (prev > value.length ? value.length : prev));
  }, [value]);

  useInput(
    (input, key) => {
      // 处理本次按键前，先把可能被移到 caret 的真实光标停回 anchor，
      // 否则 Ink 由本次 setState 触发的重绘会从错误位置擦除。
      if (cursorMovedRef.current) {
        parkCursor(stdout);
        cursorMovedRef.current = false;
      }
      // 触发一次重渲染，保证下面 effect 重跑、把光标移回 caret（即便本次按键无状态变化）
      setTick((t) => t + 1);

      if ((key.ctrl && input === "c") || key.tab || (key.shift && key.tab)) {
        return;
      }

      if (key.return) {
        onSubmit(value);
        return;
      }

      // ↑：回填更旧一条历史
      if (key.upArrow) {
        if (history.length === 0) return;
        if (historyIndexRef.current === -1) {
          draftRef.current = value;
          historyIndexRef.current = history.length - 1;
        } else {
          historyIndexRef.current = Math.max(0, historyIndexRef.current - 1);
        }
        const next = history[historyIndexRef.current];
        setCursorOffset(next.length);
        onChange(next);
        return;
      }

      // ↓：回填更新一条历史；越过最新则恢复草稿
      if (key.downArrow) {
        if (historyIndexRef.current === -1) return;
        historyIndexRef.current += 1;
        let next: string;
        if (historyIndexRef.current >= history.length) {
          historyIndexRef.current = -1;
          next = draftRef.current;
        } else {
          next = history[historyIndexRef.current];
        }
        setCursorOffset(next.length);
        onChange(next);
        return;
      }

      if (key.leftArrow) {
        setCursorOffset((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.rightArrow) {
        setCursorOffset((prev) => Math.min(value.length, prev + 1));
        return;
      }

      if (key.backspace || key.delete) {
        if (cursorOffset > 0) {
          const nextValue =
            value.slice(0, cursorOffset - 1) + value.slice(cursorOffset);
          setCursorOffset(cursorOffset - 1);
          historyIndexRef.current = -1;
          onChange(nextValue);
        }
        return;
      }

      // 可打印字符：在光标处插入
      const nextValue =
        value.slice(0, cursorOffset) + input + value.slice(cursorOffset);
      setCursorOffset(cursorOffset + input.length);
      historyIndexRef.current = -1;
      onChange(nextValue);
    },
    { isActive },
  );

  // 渲染后把真实光标移到 caret（推迟到 Ink 节流写入之后），让 IME 候选框跟随
  useEffect(() => {
    if (!isActive) return;
    const timer = setTimeout(() => {
      const col =
        1 + promptWidth + stringWidth(value.slice(0, cursorOffset));
      moveCursorToCaret(stdout, col);
      cursorMovedRef.current = true;
    }, 0);
    return () => clearTimeout(timer);
  }, [value, cursorOffset, tick, isActive, stdout, promptWidth]);

  // 离开 idle 阶段或卸载时，把光标停回 anchor，避免影响后续 Ink 渲染
  useEffect(() => {
    if (isActive) return;
    if (cursorMovedRef.current) {
      parkCursor(stdout);
      cursorMovedRef.current = false;
    }
  }, [isActive, stdout]);
  useEffect(
    () => () => {
      if (cursorMovedRef.current) {
        parkCursor(stdout);
        cursorMovedRef.current = false;
      }
    },
    [stdout],
  );

  if (value.length === 0 && placeholder) {
    return <Text color="gray">{placeholder}</Text>;
  }
  return <Text>{value}</Text>;
}

export default PromptInput;
