/**
 * 思考阶段动画
 *
 * 在 agent 工作（等待 LLM 响应）期间展示动态指示，参考 Claude Code：
 *   - ink-spinner 旋转动画
 *   - 已用时计数（每秒刷新）
 *   - 「按 Esc 中断」提示文案（实际中断功能由 US-012 实现）
 *
 * 该组件仅在 running 阶段被挂载，因此每次新的运行都会重新计时（seconds 从 0 开始）。
 */

import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";

/** 已用时展示：不足 1 分钟用「Ns」，超过则用「Xm Ys」。 */
function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function ThinkingIndicator(): React.ReactElement {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    // 每秒累加用时
    const tick = setInterval(() => setSeconds((s) => s + 1), 1000);

    return () => {
      clearInterval(tick);
    };
  }, []);

  return (
    <Box marginTop={1}>
      <Text color="yellow">
        <Spinner type="dots" />
      </Text>
      <Text color="yellow">
        {" "}
        思考中…（{formatElapsed(seconds)}）{"  "}
      </Text>
      <Text color="gray">按 Esc 中断</Text>
    </Box>
  );
}
