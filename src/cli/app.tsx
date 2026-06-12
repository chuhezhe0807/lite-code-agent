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

import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput, render } from "ink";
import type { SessionController } from "./controller.js";
import type { Block, AuthRequest, Phase } from "./types.js";
import type { Todo } from "../tools/index.js";
import { ThinkingIndicator } from "./thinking.js";
import PromptInput from "./promptInput.js";
import { loadHistory, appendHistory } from "./history.js";
import { summarizeTodos } from "./todoSummary.js";

/** 块内文本在界面上最多显示的字符数，超出则省略（仅影响展示，不影响发给模型的内容） */
const MAX_BLOCK_COUNT = 100;

/** 运行中两次 Ctrl+C 判定为「退出」的时间窗口（毫秒）；超过则第二次视为新的续接式中断 */
const DOUBLE_CTRL_C_WINDOW_MS = 1500;

/** 把文本裁剪到最多 maxCount 个字符，超出时追加省略提示 */
function clampCount(text: string, maxCount = MAX_BLOCK_COUNT): string {
  if (text.length <= maxCount) {
    return text;
  }

  return (
    text.slice(0, maxCount) +
    `\n…（共 ${text.length} 个字符，省略 ${text.length - maxCount} 个字符）`
  );
}

/** 从 run_command 工具调用的参数文本中解析出命令字符串，失败或缺字段时返回 null */
function parseCommand(text: string): string | null {
  try {
    const args = JSON.parse(text) as unknown;
    if (
      args &&
      typeof args === "object" &&
      typeof (args as { command?: unknown }).command === "string"
    ) {
      return (args as { command: string }).command;
    }
  } catch {
    // 非合法 JSON，回退通用渲染
  }
  return null;
}

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
    case "tool-call": {
      // run_command 工具直接展示命令本身，用执行工具名包裹，如 Bash(npm test)
      if (block.toolName === "run_command") {
        const command = parseCommand(block.text);
        if (command !== null) {
          return (
            <Box marginTop={1} borderStyle="round" borderColor="blue" paddingX={1} flexDirection="column">
              <Text color="blue">{clampCount(`Bash(${command})`)}</Text>
            </Box>
          );
        }
      }
      return (
        <Box marginTop={1} borderStyle="round" borderColor="blue" paddingX={1} flexDirection="column">
          <Text color="blue">⚙ 调用工具：{block.toolName}</Text>
          <Text color="gray">{clampCount(block.text)}</Text>
        </Box>
      );
    }
    case "tool-result":
      return (
        <Box marginLeft={2} flexDirection="column">
          <Text color="green">↳ {block.toolName ?? "结果"}：</Text>
          <Text color="gray">{clampCount(block.text)}</Text>
        </Box>
      );
    case "todos":
      // 任务清单全部完成后落入内容流的快照，复用 TodoView 渲染
      return block.todos ? <TodoView todos={block.todos} /> : <></>;
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

/** 一个可选项 */
interface SelectOption {
  label: string;
  value: string;
}

/**
 * 方向键选择列表：↑/↓ 移动高亮，Enter 选中。
 * 仅在挂载时激活按键监听（授权阶段才渲染，故不会与输入框冲突）。
 */
function SelectList({
  options,
  onSelect,
}: {
  options: SelectOption[];
  onSelect: (value: string) => void;
}): React.ReactElement {
  const [index, setIndex] = useState(0);
  useInput((_char, key) => {
    if (key.upArrow) {
      setIndex((i) => (i - 1 + options.length) % options.length);
    } else if (key.downArrow) {
      setIndex((i) => (i + 1) % options.length);
    } else if (key.return) {
      onSelect(options[index].value);
    }
  });
  return (
    <Box flexDirection="column">
      {options.map((opt, i) => (
        <Text key={opt.value} color={i === index ? "green" : "gray"}>
          {i === index ? "❯ " : "  "}
          {opt.label}
        </Text>
      ))}
    </Box>
  );
}

/** 不同模式下的授权选项 */
const DECISION_OPTIONS: SelectOption[] = [
  { label: "本次允许", value: "y" },
  { label: "本次拒绝", value: "n" },
  { label: "始终允许（记住规则）", value: "a" },
  { label: "始终拒绝（记住规则）", value: "d" },
];
const CONFIRM_OPTIONS: SelectOption[] = [
  { label: "确认写入规则", value: "y" },
  { label: "不写入", value: "n" },
];

/** 授权请求展示（方向键选择 + Enter 确认） */
function AuthView({
  auth,
  onSelect,
}: {
  auth: AuthRequest;
  onSelect: (value: string) => void;
}): React.ReactElement {
  const options = auth.mode === "decision" ? DECISION_OPTIONS : CONFIRM_OPTIONS;
  return (
    <Box marginTop={1} borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
      <Text color="yellow">需要授权：</Text>
      <Text>{auth.detail}</Text>
      <Text color="gray">（↑/↓ 选择，Enter 确认）</Text>
      <SelectList options={options} onSelect={onSelect} />
    </Box>
  );
}

/**
 * Todo 列表展示：○ 待办 / ◐ 进行中 / ✓ 已完成。
 * 最多展示 3 条（优先包含进行中的任务）；超出时用省略行标明总数与已完成数。
 */
function TodoView({ todos }: { todos: Todo[] }): React.ReactElement {
  const { visible, total, completed, truncated } = summarizeTodos(todos);
  return (
    <Box marginTop={1} borderStyle="round" borderColor="magenta" paddingX={1} flexDirection="column">
      <Text color="magenta">任务清单</Text>
      {visible.map((t, i) => {
        const glyph =
          t.status === "completed" ? "✓" : t.status === "in_progress" ? "◐" : "○";
        const color =
          t.status === "completed"
            ? "green"
            : t.status === "in_progress"
              ? "yellow"
              : "gray";
        return (
          <Text key={`${i}-${t.content}`} color={color}>
            {glyph} {t.content}
          </Text>
        );
      })}
      {truncated && (
        <Text dimColor>{`…（共 ${total} 个任务，${completed} 个已完成）`}</Text>
      )}
    </Box>
  );
}

/** 主应用组件 */
function App({
  controller,
  litecodeDir,
}: {
  controller: SessionController;
  litecodeDir: string;
}): React.ReactElement {
  const { exit } = useApp();
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [auth, setAuth] = useState<AuthRequest | null>(null);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>(() => loadHistory(litecodeDir));
  // 当前「全部完成」的任务清单是否已落入内容流，避免重复追加（见 onTodos）
  const todosMovedRef = useRef(false);

  // 订阅 controller 事件
  useEffect(() => {
    const onBlock = (b: Block) => setBlocks((prev) => [...prev, b]);
    const onPhase = (p: Phase) => setPhase(p);
    const onAuth = (req: AuthRequest) => {
      setAuth(req);
      setPhase("auth");
    };
    // 任务清单更新：
    // - 进行中：作为「实时贴底」的 TodoView 展示，方便持续看到进度。
    // - 全部完成：把这份清单快照成一个 block 落入内容流（固定在完成时刻的位置，
    //   后续内容排在其下方，从而随内容一起向上滚动），并清空实时清单。
    //   movedRef 防止同一份「全部完成」清单被重复落盘；一旦出现未完成的新清单则重置。
    const onTodos = (list: Todo[]) => {
      const allDone = list.length > 0 && list.every((t) => t.status === "completed");
      if (allDone) {
        if (!todosMovedRef.current) {
          todosMovedRef.current = true;
          setBlocks((prev) => [...prev, { kind: "todos", text: "", todos: list }]);
        }
        setTodos([]);
      } else {
        todosMovedRef.current = false;
        setTodos(list);
      }
    };
    controller.on("block", onBlock);
    controller.on("phase", onPhase);
    controller.on("auth", onAuth);
    controller.on("todos", onTodos);
    return () => {
      controller.off("block", onBlock);
      controller.off("phase", onPhase);
      controller.off("auth", onAuth);
      controller.off("todos", onTodos);
    };
  }, [controller]);

  // 上次按下 Ctrl+C 的时间戳，用于运行阶段「双击退出」判定
  const lastCtrlCRef = useRef(0);

  // running 阶段：Esc 丢弃式中断；Ctrl+C 续接式中断（双击退出）
  useInput(
    (input, key) => {
      if (key.escape) {
        controller.abort("discard");
        return;
      }
      if (key.ctrl && input === "c") {
        const now = Date.now();
        // 窗口内再次按下 → 退出程序
        if (now - lastCtrlCRef.current <= DOUBLE_CTRL_C_WINDOW_MS) {
          exit();
          return;
        }
        lastCtrlCRef.current = now;
        // 单击 → 续接式中断：保留上下文、回到输入框等待纠正指令
        controller.abort("resume");
      }
    },
    { isActive: phase === "running" },
  );

  // idle 阶段：单按 Ctrl+C 直接退出（无二次确认）
  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") exit();
    },
    { isActive: phase === "idle" },
  );

  // auth 阶段：用户用方向键选择后回传结果
  const onAuthSelect = (value: string) => {
    if (!auth) return;
    const req = auth;
    setAuth(null);
    setPhase("running");
    req.resolve(value);
  };

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
    setHistory(appendHistory(litecodeDir, v));
    void controller.submit(v);
  };

  return (
    <Box flexDirection="column">
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} />
      ))}

      {todos.length > 0 && <TodoView todos={todos} />}

      {phase === "running" && <ThinkingIndicator />}

      {phase === "auth" && auth && (
        <AuthView auth={auth} onSelect={onAuthSelect} />
      )}

      {phase === "idle" && (
        <PromptInput
          value={input}
          onChange={setInput}
          onSubmit={onSubmit}
          placeholder="输入任务，/exit 退出"
          history={history}
          isActive={phase === "idle"}
        />
      )}
    </Box>
  );
}

/**
 * 启动 Ink CLI。
 * @param controller 已构建好的会话控制器
 * @param litecodeDir .litecode 目录绝对路径（用于持久化输入历史）
 */
export function startCli(controller: SessionController, litecodeDir: string): void {
  // 关闭 Ink 默认的 Ctrl+C 退出，改由各阶段 useInput 自行管理
  // （running 单击续接 / 双击退出，idle 单击退出）
  render(<App controller={controller} litecodeDir={litecodeDir} />, {
    exitOnCtrlC: false,
  });
}
