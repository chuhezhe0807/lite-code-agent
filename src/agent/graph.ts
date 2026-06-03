/**
 * LangGraph Agent 主循环
 *
 * 用 StateGraph 编排 agent 的「思考 → 调用工具 → 观察结果 → 继续」ReAct 循环：
 *
 *        ┌─────────┐   有 tool_calls 且未超迭代上限   ┌────────┐
 *  START→│  agent  │ ───────────────────────────────→ │ tools  │
 *        │ (调LLM) │ ←─────────────────────────────── │(授权+执行)│
 *        └─────────┘                                  └────────┘
 *            │ 无 tool_calls（或超过迭代上限）
 *            ↓
 *           END
 *
 * - agent 节点：把工具绑定到模型后调用 LLM，得到回复（可能含 tool_calls）。
 * - tools 节点：逐个 tool_call 先过授权层（US-007），允许才执行；拒绝/出错都以
 *   ToolMessage 形式回传，让 agent 能据此调整而非崩溃。
 * - 最大迭代次数保护：防止模型陷入无限工具调用循环。
 */

import {
  StateGraph,
  Annotation,
  messagesStateReducer,
  START,
  END,
} from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";
import {
  AIMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { ToolSpec } from "../tools/index.js";
import type { PermissionManager } from "../permissions/manager.js";

/** 默认系统提示：把模型定位成一个谨慎的本地代码助手 */
const DEFAULT_SYSTEM_PROMPT = `你是一个运行在用户本地终端的轻量级代码助手（lite code agent）。
你可以使用提供的工具读写文件、列举目录、执行命令来完成用户的编程任务。
约定：
- 所有文件与命令操作都被限制在工作目录内，越界会被拒绝。
- 写入、编辑、执行命令属于敏感操作，会经过用户授权；若被拒绝，请理解用户意图并调整方案，不要重复尝试同一操作。
- 优先用 read_file / list_dir 了解项目，再动手修改。
- 完成任务后用简洁的中文说明你做了什么。`;

/**
 * Agent 图状态：
 * - messages：对话消息，用 messagesStateReducer 累积（能正确处理追加）。
 * - iterations：agent 节点已执行的轮数，用于最大迭代保护。
 */
export const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  iterations: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
});

/** 创建主循环图所需依赖 */
export interface AgentGraphDeps {
  /** LLM 模型实例 */
  model: BaseChatModel;
  /** 带授权级别的工具数组 */
  tools: ToolSpec[];
  /** 授权管理器 */
  manager: PermissionManager;
  /** 最大迭代次数（agent 节点执行次数上限） */
  maxIterations: number;
  /** 可选自定义系统提示 */
  systemPrompt?: string;
}

/**
 * 构建并编译 agent 主循环图。
 * @returns 可直接 invoke/stream 的已编译图
 */
export function createAgentGraph(deps: AgentGraphDeps) {
  const { model, tools, manager, maxIterations } = deps;
  const systemPrompt = deps.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

  // 模型必须支持工具绑定（provider 工厂已校验 bindTools 存在）
  if (typeof model.bindTools !== "function") {
    throw new Error("当前模型不支持工具调用（bindTools），无法构建 agent。");
  }
  const modelWithTools = model.bindTools(tools.map((t) => t.tool));

  // 按名字索引工具，便于 tools 节点查找
  const specByName = new Map<string, ToolSpec>(
    tools.map((t) => [t.tool.name, t]),
  );

  /** agent 节点：调用 LLM */
  async function agentNode(
    state: typeof AgentState.State,
    config?: RunnableConfig,
  ): Promise<Partial<typeof AgentState.State>> {
    // 首轮在最前面注入系统提示
    const msgs =
      state.iterations === 0
        ? [new SystemMessage(systemPrompt), ...state.messages]
        : state.messages;
    const response = await modelWithTools.invoke(msgs, config);
    return { messages: [response], iterations: state.iterations + 1 };
  }

  /** tools 节点：授权 + 执行每个 tool_call */
  async function toolsNode(
    state: typeof AgentState.State,
    config?: RunnableConfig,
  ): Promise<Partial<typeof AgentState.State>> {
    const last = state.messages[state.messages.length - 1] as AIMessage;
    const calls = last.tool_calls ?? [];
    const results: ToolMessage[] = [];

    for (const call of calls) {
      const spec = specByName.get(call.name);
      const callId = call.id ?? call.name;

      if (!spec) {
        results.push(
          new ToolMessage({
            content: `错误：未知工具 '${call.name}'。`,
            tool_call_id: callId,
            name: call.name,
          }),
        );
        continue;
      }

      // 授权拦截
      const auth = await manager.authorize(spec, call.args);
      if (!auth.allowed) {
        results.push(
          new ToolMessage({
            content: auth.reason ?? "操作被拒绝。",
            tool_call_id: callId,
            name: call.name,
          }),
        );
        continue;
      }

      // 执行工具（透传 config 以携带 AbortSignal，供 run_command 中断）
      try {
        const output = await spec.tool.invoke(call.args, config);
        results.push(
          new ToolMessage({
            content: typeof output === "string" ? output : JSON.stringify(output),
            tool_call_id: callId,
            name: call.name,
          }),
        );
      } catch (err) {
        results.push(
          new ToolMessage({
            content: `工具执行出错：${(err as Error).message}`,
            tool_call_id: callId,
            name: call.name,
          }),
        );
      }
    }

    return { messages: results };
  }

  /** 条件边：决定 agent 之后去 tools 还是结束 */
  function shouldContinue(state: typeof AgentState.State): "tools" | typeof END {
    const last = state.messages[state.messages.length - 1] as AIMessage;
    const hasToolCalls = (last?.tool_calls?.length ?? 0) > 0;
    if (!hasToolCalls) return END;
    // 超过最大迭代次数则强制结束，防止无限循环
    if (state.iterations >= maxIterations) return END;
    return "tools";
  }

  const graph = new StateGraph(AgentState)
    .addNode("agent", agentNode)
    .addNode("tools", toolsNode)
    .addEdge(START, "agent")
    .addConditionalEdges("agent", shouldContinue, ["tools", END])
    .addEdge("tools", "agent")
    .compile();

  return graph;
}
