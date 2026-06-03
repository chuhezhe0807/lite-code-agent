/**
 * 思考阶段动画
 *
 * 在 agent 工作（等待 LLM 响应）期间展示动态指示，参考 Claude Code：
 *   - ink-spinner 旋转动画
 *   - 状态文案在一组词间轮换（思考中 / 分析中 / ...）
 *   - 已用时计数（每秒刷新）
 *   - 「按 Esc 中断」提示文案（实际中断功能由 US-012 实现）
 *
 * 该组件仅在 running 阶段被挂载，因此每次新的运行都会重新计时（seconds 从 0 开始）。
 */

import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";

/** 轮换展示的状态文案 */
const PHRASES = ["思考中", "分析中", "规划中", "处理中"];

/** 文案轮换间隔（毫秒） */
const ROTATE_INTERVAL_MS = 2000;

export function ThinkingIndicator(): React.ReactElement {
  const [seconds, setSeconds] = useState(0);
  const [phraseIdx, setPhraseIdx] = useState(0);

  useEffect(() => {
    // 每秒累加用时
    const tick = setInterval(() => setSeconds((s) => s + 1), 1000);
    // 定时轮换文案
    const rotate = setInterval(
      () => setPhraseIdx((i) => (i + 1) % PHRASES.length),
      ROTATE_INTERVAL_MS,
    );
    return () => {
      clearInterval(tick);
      clearInterval(rotate);
    };
  }, []);

  return (
    <Box marginTop={1}>
      <Text color="yellow">
        <Spinner type="dots" />
      </Text>
      <Text color="yellow">
        {" "}
        {PHRASES[phraseIdx]}…（{seconds}s）{"  "}
      </Text>
      <Text color="gray">按 Esc 中断</Text>
    </Box>
  );
}
