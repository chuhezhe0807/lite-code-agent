/**
 * 输入行组件
 *
 * 基于 ink-text-input（TextInput）做文本编辑：它把光标渲染成行内的反色字符，
 * 由 Ink 负责换行布局，因此输入超过一行时不会出现「真实硬件光标错位」的问题。
 *
 * 在其之上仅补一层 ↑/↓ 历史导航（TextInput 自身会忽略上下方向键）：
 *   - ↑：回填更旧一条历史；↓：回填更新一条，越过最新则恢复进入导航前的草稿。
 *   - 历史回填后通过变更 key 让 TextInput 重新挂载，从而把光标重置到行尾。
 *
 * 注：中文输入法候选框的定位交给终端默认行为（候选框可能停在屏幕底部），不再特殊处理。
 */

import React, { useRef, useState } from "react";
import { useInput } from "ink";
import TextInput from "ink-text-input";

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

function PromptInput({
  value,
  onChange,
  onSubmit,
  placeholder = "",
  history,
  isActive,
}: PromptInputProps): React.ReactElement {
  // -1 表示「当前草稿」，未进入历史导航
  const historyIndexRef = useRef(-1);
  // 进入历史导航前暂存的草稿，用于 ↓ 越过最新条目时恢复
  const draftRef = useRef("");
  // 历史回填时自增：作为 TextInput 的 key，触发重挂载使光标落到行尾
  const [remountKey, setRemountKey] = useState(0);

  // ↑/↓ 历史导航（TextInput 忽略上下键，故由这里补上）
  useInput(
    (_input, key) => {
      if (key.upArrow) {
        if (history.length === 0) return;
        if (historyIndexRef.current === -1) {
          draftRef.current = value;
          historyIndexRef.current = history.length - 1;
        } else {
          historyIndexRef.current = Math.max(0, historyIndexRef.current - 1);
        }
        onChange(history[historyIndexRef.current]);
        setRemountKey((k) => k + 1);
        return;
      }
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
        onChange(next);
        setRemountKey((k) => k + 1);
      }
    },
    { isActive },
  );

  // 用户手动编辑内容即退出历史导航模式（下次 ↑ 重新从最新一条开始）
  const handleChange = (v: string): void => {
    historyIndexRef.current = -1;
    onChange(v);
  };

  return (
    <TextInput
      key={remountKey}
      value={value}
      onChange={handleChange}
      onSubmit={onSubmit}
      placeholder={placeholder}
      focus={isActive}
    />
  );
}

export default PromptInput;
