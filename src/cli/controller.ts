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
  type AIMessage,
  type BaseMessage,
  type ToolMessage,
  type MessageContent,
} from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { AppConfig } from "../config.js";
import type { ToolSpec, Todo } from "../tools/index.js";
import type { LocalSettings } from "../permissions/settings.js";
import { createPermissionManager } from "../permissions/manager.js";
import type { AuthPrompter, AuthChoice } from "../permissions/prompter.js";
import { createAgentGraph } from "../agent/graph.js";
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
  /** 当前运行的中断控制器（用于 Esc 中断）；空闲时为 null */
  private currentAbort: AbortController | null = null;

  constructor(deps: SessionControllerDeps) {
    super();
    this.maxIterations = deps.config.maxIterations;
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
    });
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
    const inputMessages = [...this.history, human];
    const collected: BaseMessage[] = [human];

    try {
      const stream = await this.graph.stream(
        { messages: inputMessages },
        {
          streamMode: "updates",
          // 留足递归预算：每轮 agent+tools 两步
          recursionLimit: this.maxIterations * 2 + 5,
          signal: abort.signal,
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
