/**
 * Ink CLI 应用组件
 *
 * 纯视图 + 输入层：订阅 SessionController 的事件来更新渲染状态，把用户输入/按键回传给 controller。
 * 不包含任何 agent 业务逻辑。
 *
 * 三种阶段（phase）：
 *   - idle    展示输入框，等待用户输入任务（/exit 退出）。
 *   - running agent 正在工作（US-010 会在此加入思考动画，当前显示静态提示）。
 *   - auth    需要用户按键授权（y/n/a/d 或 y/n 确认），此时用 useInput 捕获按键。
 */

import React, { useEffect, useState } from "react";
import { Box, Text, useApp, useInput, render } from "ink";
import TextInput from "ink-text-input";
import type { SessionController } from "./controller.js";
import type { Block, AuthRequest, Phase } from "./types.js";

/** 单个渲染块的展示 */
function BlockView({ block }: { block: Block }): React.ReactElement {
  switch (block.kind) {
    case "user":
      return (
        <Box marginTop={1}>
          <Text color="cyan">{"❯ "}</Text>
          <Text>{block.text}</Text>
        </Box>
      );
    case "ai":
      return (
        <Box marginTop={1}>
          <Text color="white">{block.text}</Text>
        </Box>
      );
    case "tool-call":
      return (
        <Box marginTop={1} borderStyle="round" borderColor="blue" paddingX={1} flexDirection="column">
          <Text color="blue">⚙ 调用工具：{block.toolName}</Text>
          <Text color="gray">{block.text}</Text>
        </Box>
      );
    case "tool-result":
      return (
        <Box marginLeft={2} flexDirection="column">
          <Text color="green">↳ {block.toolName ?? "结果"}：</Text>
          <Text color="gray">{block.text}</Text>
        </Box>
      );
    case "error":
      return (
        <Box marginTop={1}>
          <Text color="red">{block.text}</Text>
        </Box>
      );
    case "info":
    default:
      return (
        <Box marginTop={1}>
          <Text color="yellow">{block.text}</Text>
        </Box>
      );
  }
}

/** 授权请求展示 */
function AuthView({ auth }: { auth: AuthRequest }): React.ReactElement {
  return (
    <Box marginTop={1} borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
      <Text color="yellow">需要授权：</Text>
      <Text>{auth.detail}</Text>
      <Text color="yellow">
        {auth.mode === "decision"
          ? "[y]本次允许  [n]本次拒绝  [a]始终允许  [d]始终拒绝"
          : "[y]确认写入规则  [n]不写入"}
      </Text>
    </Box>
  );
}

/** 主应用组件 */
function App({ controller }: { controller: SessionController }): React.ReactElement {
  const { exit } = useApp();
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [auth, setAuth] = useState<AuthRequest | null>(null);
  const [input, setInput] = useState("");

  // 订阅 controller 事件
  useEffect(() => {
    const onBlock = (b: Block) => setBlocks((prev) => [...prev, b]);
    const onPhase = (p: Phase) => setPhase(p);
    const onAuth = (req: AuthRequest) => {
      setAuth(req);
      setPhase("auth");
    };
    controller.on("block", onBlock);
    controller.on("phase", onPhase);
    controller.on("auth", onAuth);
    return () => {
      controller.off("block", onBlock);
      controller.off("phase", onPhase);
      controller.off("auth", onAuth);
    };
  }, [controller]);

  // auth 阶段捕获按键
  useInput(
    (char) => {
      if (!auth) return;
      const ch = char.toLowerCase();
      const valid =
        auth.mode === "decision"
          ? ["y", "n", "a", "d"]
          : ["y", "n"];
      if (!valid.includes(ch)) return;
      const req = auth;
      setAuth(null);
      setPhase("running");
      req.resolve(ch);
    },
    { isActive: phase === "auth" },
  );

  // 处理用户输入提交
  const onSubmit = (value: string) => {
    if (phase !== "idle") return;
    const v = value.trim();
    setInput("");
    if (v === "/exit" || v === "/quit") {
      exit();
      return;
    }
    if (v.length === 0) return;
    void controller.submit(v);
  };

  return (
    <Box flexDirection="column">
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} />
      ))}

      {phase === "running" && (
        <Box marginTop={1}>
          <Text color="yellow">运行中…</Text>
        </Box>
      )}

      {phase === "auth" && auth && <AuthView auth={auth} />}

      {phase === "idle" && (
        <Box marginTop={1}>
          <Text color="cyan">{"> "}</Text>
          <TextInput
            value={input}
            onChange={setInput}
            onSubmit={onSubmit}
            placeholder="输入任务，/exit 退出"
          />
        </Box>
      )}
    </Box>
  );
}

/**
 * 启动 Ink CLI。
 * @param controller 已构建好的会话控制器
 */
export function startCli(controller: SessionController): void {
  render(<App controller={controller} />);
}
