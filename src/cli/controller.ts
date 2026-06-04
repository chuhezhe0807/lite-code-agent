/**
 * SessionController —— 连接 agent 主循环与 Ink UI 的桥梁
 *
 * 它身兼三职：
 *   1. 作为 AuthPrompter：当授权层需要「问用户」时，发出 'auth' 事件并返回一个 Promise，
 *      等 UI 收到按键后调用 resolve 兑现（promise-bridge）。这样授权的等待天然挂起
 *      stream 的推进，期间事件循环空闲、UI 仍可响应输入。
 *   2. 作为运行器：submit() 用 graph.stream 增量运行，把每一步翻译成可渲染的 Block 事件。
 *   3. 作为多轮会话的记忆：用 history 累积历次消息，实现连续对话。
 *
 * 通过 EventEmitter 与 UI 解耦：UI 只订阅 'block' / 'phase' / 'auth' 事件，不关心 agent 细节。
 */

import { EventEmitter } from "node:events";
import {
  HumanMessage,
  ToolMessage,
  type AIMessage,
  type BaseMessage,
  type MessageContent,
} from "@langchain/core/messages";
import { truncateHeadTail } from "../util/truncate.js";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { AppConfig } from "../config.js";
import type { ToolSpec, Todo } from "../tools/index.js";
import type { LocalSettings } from "../permissions/settings.js";
import { createPermissionManager } from "../permissions/manager.js";
import type { AuthPrompter, AuthChoice } from "../permissions/prompter.js";
import { createAgentGraph } from "../agent/graph.js";
import { createLangfuseHandler } from "../observability/langfuse.js";
import type { CallbackHandler } from "langfuse-langchain";
import type { Block } from "./types.js";

/** 把 LangChain 的 MessageContent（可能是字符串或内容块数组）转为纯文本 */
function textOf(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part.type === "text") return part.text;
      return "";
    })
    .join("");
}

/**
 * 压缩历史中的大块工具结果（US-015），仅用于「重发给模型」。
 *
 * 多轮对话每轮都要把全部历史重新发给模型，旧工具结果（大文件、长命令输出）是输入 token 大头。
 * 这里对超过字节预算的 ToolMessage 做头尾截断并加重读提示，保留消息结构（tool_call_id/name）
 * 以免破坏 tool_use/tool_result 配对。返回新数组，不改动原历史（产生当轮模型已见过完整内容）。
 *
 * @param messages 待发送的消息序列
 * @param maxBytes 单条工具结果字节上限；<=0 时不压缩
 */
function compactToolResults(
  messages: BaseMessage[],
  maxBytes: number,
): BaseMessage[] {
  if (maxBytes <= 0) return messages;
  return messages.map((m) => {
    if (!(m instanceof ToolMessage) || typeof m.content !== "string") return m;
    if (Buffer.byteLength(m.content, "utf-8") <= maxBytes) return m;
    const truncated =
      truncateHeadTail(m.content, { maxBytes }) +
      "\n[历史工具结果已压缩以节省 token；如需完整内容请重新调用相应工具]";
    return new ToolMessage({
      content: truncated,
      tool_call_id: m.tool_call_id,
      name: typeof m.name === "string" ? m.name : undefined,
    });
  });
}

/** 创建 SessionController 所需依赖 */
export interface SessionControllerDeps {
  config: AppConfig;
  model: BaseChatModel;
  tools: ToolSpec[];
  settings: LocalSettings;
  litecodeDir: string;
}

export class SessionController extends EventEmitter implements AuthPrompter {
  /** 跨轮累积的对话历史 */
  private history: BaseMessage[] = [];
  private readonly graph: ReturnType<typeof createAgentGraph>;
  private readonly maxIterations: number;
  /** 历史工具结果重发时的字节上限（US-015，0=不压缩） */
  private readonly historyToolResultMaxBytes: number;
  /** 当前运行的中断控制器（用于 Esc 中断）；空闲时为 null */
  private currentAbort: AbortController | null = null;
  /** 可选的 Langfuse 监控回调；未配置时为 undefined */
  private readonly langfuse: CallbackHandler | undefined;

  constructor(deps: SessionControllerDeps) {
    super();
    this.maxIterations = deps.config.maxIterations;
    this.historyToolResultMaxBytes = deps.config.historyToolResultMaxBytes;
    // 用自身作为 prompter 构建授权管理器，再构建主循环图
    const manager = createPermissionManager({
      litecodeDir: deps.litecodeDir,
      settings: deps.settings,
      prompter: this,
    });
    this.graph = createAgentGraph({
      model: deps.model,
      tools: deps.tools,
      manager,
      maxIterations: this.maxIterations,
      promptCaching: deps.config.promptCaching,
    });
    // 可选监控：配置齐全才创建，否则 undefined（不影响运行）
    this.langfuse = createLangfuseHandler(deps.config);
  }

  // ===== AuthPrompter 实现（promise-bridge）=====

  askDecision(detail: string): Promise<AuthChoice> {
    return new Promise<AuthChoice>((resolve) => {
      this.emit("auth", {
        detail,
        mode: "decision",
        resolve: (v: string) => resolve(v as AuthChoice),
      });
    });
  }

  async confirmRule(ruleText: string): Promise<boolean> {
    const ans = await new Promise<string>((resolve) => {
      this.emit("auth", {
        detail: `将记住规则：${ruleText}`,
        mode: "confirm",
        resolve,
      });
    });
    return ans === "y";
  }

  // ===== 运行器 =====

  /**
   * 提交一条用户输入，运行一轮 agent，并通过事件流式产出渲染块。
   * @param text 用户输入
   */
  async submit(text: string): Promise<void> {
    this.pushBlock({ kind: "user", text });
    this.emit("phase", "running");

    // 每轮运行创建独立的中断控制器，signal 透传给图（贯穿 LLM 调用与工具执行）
    const abort = new AbortController();
    this.currentAbort = abort;

    const human = new HumanMessage(text);
    // 重发给模型前压缩历史里的大块旧工具结果，降低多轮输入 token（不改动 this.history）
    const inputMessages = compactToolResults(
      [...this.history, human],
      this.historyToolResultMaxBytes,
    );
    const collected: BaseMessage[] = [human];

    try {
      const stream = await this.graph.stream(
        { messages: inputMessages },
        {
          streamMode: "updates",
          // 留足递归预算：每轮 agent+tools 两步
          recursionLimit: this.maxIterations * 2 + 5,
          signal: abort.signal,
          // 配置了 Langfuse 才挂回调，把本轮链路上报
          ...(this.langfuse ? { callbacks: [this.langfuse] } : {}),
        },
      );

      for await (const step of stream) {
        for (const [node, update] of Object.entries(step)) {
          const u = update as { messages?: BaseMessage[]; todos?: Todo[] };
          for (const m of u?.messages ?? []) {
            collected.push(m);
            this.renderMessage(node, m);
          }
          // todo 列表更新（来自 update_todos）实时推给 UI
          if (u?.todos) this.emit("todos", u.todos);
        }
      }

      // 本轮正常结束，沉淀到历史，供下一轮连续对话
      this.history = [...this.history, ...collected];
    } catch (err) {
      if (abort.signal.aborted) {
        // 被用户中断：提示「已中断」，且不把这半截对话写入历史，
        // 避免遗留「有 tool_use 却无 tool_result」的悬空消息导致下轮请求 400。
        this.pushBlock({ kind: "info", text: "已中断。" });
      } else {
        this.pushBlock({
          kind: "error",
          text: `运行出错：${(err as Error).message}`,
        });
      }
    } finally {
      this.currentAbort = null;
      // CLI 进程生命周期短，主动 flush 确保本轮链路上报到 Langfuse（失败不影响主流程）
      if (this.langfuse) {
        try {
          await this.langfuse.flushAsync();
        } catch {
          /* 监控上报失败静默忽略 */
        }
      }
      this.emit("phase", "idle");
    }
  }

  /** 中断当前正在运行的 agent（Esc 触发）。空闲时无操作。 */
  abort(): void {
    this.currentAbort?.abort();
  }

  /** 把一条消息翻译成渲染块 */
  private renderMessage(node: string, m: BaseMessage): void {
    if (node === "agent") {
      const ai = m as AIMessage;
      for (const call of ai.tool_calls ?? []) {
        this.pushBlock({
          kind: "tool-call",
          toolName: call.name,
          text: JSON.stringify(call.args),
        });
      }
      const content = textOf(ai.content);
      if (content.trim()) this.pushBlock({ kind: "ai", text: content });
    } else if (node === "tools") {
      const tm = m as ToolMessage;
      this.pushBlock({
        kind: "tool-result",
        toolName: typeof tm.name === "string" ? tm.name : undefined,
        text: textOf(tm.content),
      });
    }
  }

  /** 发出一个渲染块事件 */
  private pushBlock(block: Block): void {
    this.emit("block", block);
  }
}
