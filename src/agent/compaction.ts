/**
 * 对话历史自动压缩（US-024）——纯逻辑部分
 *
 * 长会话里 history 跨轮无限增长，每轮都要把全部历史重发给模型，迟早撑爆 context window
 * 也浪费 token。这里负责「何时压缩、从哪里切、压缩后如何拼回」的纯计算，便于单元测试；
 * 真正调用 LLM 生成摘要的副作用留在 SessionController。
 *
 * 关键约束：压缩后的消息序列必须仍满足 Anthropic 的 tool_use/tool_result 配对——
 * 不能把某个 AIMessage 的 tool_calls 与它对应的 ToolMessage 切散。为此我们只在
 * HumanMessage（一轮对话的天然起点，自身不含 tool_calls）边界切分，并把旧历史的摘要
 * 折叠进「保留段」的首条用户消息里，从而既不产生悬空 tool_call，也不产生孤儿 tool_result，
 * 还避免出现两条连续的用户消息。
 */

import {
  HumanMessage,
  AIMessage,
  ToolMessage,
  SystemMessage,
  type BaseMessage,
  type MessageContent,
} from "@langchain/core/messages";

/** 把 MessageContent（字符串或内容块数组）转为纯文本，用于字节估算与转写 */
export function contentToText(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part.type === "text") return part.text;
      return "";
    })
    .join("");
}

/** 估算单条消息的字节数：正文 + tool_calls 的 JSON（输入 token 的主要来源） */
export function estimateMessageBytes(m: BaseMessage): number {
  let bytes = Buffer.byteLength(contentToText(m.content), "utf-8");
  const calls = (m as AIMessage).tool_calls;
  if (Array.isArray(calls) && calls.length > 0) {
    bytes += Buffer.byteLength(JSON.stringify(calls), "utf-8");
  }
  return bytes;
}

/** 估算整段历史的字节数 */
export function totalBytes(messages: BaseMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageBytes(m), 0);
}

/**
 * 计算压缩切分点。
 *
 * @param messages 当前历史
 * @param maxBytes 触发阈值；<=0 或历史未超阈值时返回 null（不压缩）
 * @param keepRatio 保留段目标占比（默认 0.5）：尽量让保留段控制在 maxBytes*keepRatio 内
 * @returns { cut } —— 保留段从 messages[cut] 开始（cut 一定指向某条 HumanMessage）；
 *          无可压缩内容（找不到 >0 的 Human 边界）时返回 null
 */
export function planCompaction(
  messages: BaseMessage[],
  maxBytes: number,
  keepRatio = 0.5,
): { cut: number } | null {
  if (maxBytes <= 0) return null;
  if (totalBytes(messages) <= maxBytes) return null;

  // 收集所有 HumanMessage 的下标（一轮对话的安全起点）
  const humanIdx: number[] = [];
  messages.forEach((m, i) => {
    if (m instanceof HumanMessage) humanIdx.push(i);
  });
  // 至少要有一个「>0 的 Human 边界」才能切出「旧段(待摘要) + 保留段」
  const candidates = humanIdx.filter((i) => i > 0);
  if (candidates.length === 0) return null;

  const keepBudget = Math.floor(maxBytes * keepRatio);
  // 从最早的可切点往后找：第一个能让「保留段(messages[cut..]) 字节 <= keepBudget」的 Human 边界。
  // 这样保留尽量多的近期上下文，同时把保留段压到预算内。
  for (const cut of candidates) {
    if (totalBytes(messages.slice(cut)) <= keepBudget) {
      return { cut };
    }
  }
  // 即便只保留最后一轮也超预算：退而切在最后一个 Human 边界（保留段最小），
  // 剩下的超长由发送前的单条工具结果压缩（US-015）兜底。
  return { cut: candidates[candidates.length - 1] };
}

/**
 * 把 messages[0..cut) 的摘要折叠进保留段，返回压缩后的新历史。
 *
 * 保留段 messages[cut..] 一定以 HumanMessage 开头；我们把摘要文本作为前缀并入这条
 * 用户消息，其后的 AI/工具消息原样保留，配对关系不受影响。
 *
 * @param messages 原历史
 * @param cut 保留段起点（planCompaction 返回；必须指向 HumanMessage）
 * @param summary LLM 生成的旧历史摘要
 * @returns 压缩后的新数组（不改动入参）
 */
export function applyCompaction(
  messages: BaseMessage[],
  cut: number,
  summary: string,
): BaseMessage[] {
  const kept = messages.slice(cut);
  const first = kept[0];
  const firstText =
    first instanceof HumanMessage ? contentToText(first.content) : "";
  const merged = new HumanMessage(
    `[早前对话的摘要，由系统自动压缩以节省上下文]\n${summary}\n\n[最近的请求]\n${firstText}`,
  );
  return [merged, ...kept.slice(1)];
}

/**
 * 发送前的最后一道兜底：修复 tool_use / tool_result 的配对，确保满足 Anthropic 约束
 * 「每条带 tool_calls 的消息后必须紧跟覆盖全部 call 的 tool_result」。
 *
 * 为什么需要：死循环保护触发时，shouldContinue 会停在「带 tool_calls 的 AI」之后，
 * 该 AI 的工具从未执行，却被正常结束分支原样写进 history，留下「悬空 tool_use」；
 * 下一轮再追加新的 Human，就会出现「tool_use 后紧跟 Human 而非 tool_result」→ 400。
 * 此外压缩保留段理论上以 Human 开头，但任何上游改动都可能打破该前提。
 * 中断续接路径由 sanitizeForResume 单独处理（悬空在尾部，追加占位即满足配对），这里不重复。
 *
 * 规则：
 *   1. 每条带 tool_calls 的 AI 消息，未被其后紧邻 tool_result 覆盖的 call，就在它
 *      「正后面」补一条占位 tool_result；
 *   2. 丢弃没有前驱 tool_use 的孤儿 tool_result。
 *
 * @returns 修复后的新数组（不改动入参）
 */
export function repairToolPairs(messages: BaseMessage[]): BaseMessage[] {
  const out: BaseMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    // 走到这里的 ToolMessage 必是孤儿：正常配对的会在下方内层循环被消费掉
    if (m instanceof ToolMessage) continue;

    out.push(m);
    const calls = (m as AIMessage).tool_calls;
    if (!Array.isArray(calls) || calls.length === 0) continue;

    // 收集紧随其后的连续 ToolMessage，记录已解决的 call id
    const resolved = new Set<string>();
    let j = i + 1;
    while (j < messages.length && messages[j] instanceof ToolMessage) {
      const tm = messages[j] as ToolMessage;
      out.push(tm);
      if (typeof tm.tool_call_id === "string") resolved.add(tm.tool_call_id);
      j++;
    }
    // 为未解决的 call 在「紧跟该 AI 之后」补占位结果，避免悬空 tool_use 触发 400
    for (const call of calls) {
      if (call.id && !resolved.has(call.id)) {
        out.push(
          new ToolMessage({
            content:
              "[该工具调用未产生结果（可能因达到迭代上限或被中断而未执行），可忽略或按需重新发起]",
            tool_call_id: call.id,
            name: call.name,
          }),
        );
      }
    }
    i = j - 1; // 跳过已消费的 ToolMessage
  }
  return out;
}

/**
 * 把待摘要的旧消息转写成纯文本 transcript，供摘要提示使用。
 * 标注角色，工具调用与结果各占一行，便于模型理解上下文脉络。
 */
export function renderTranscript(messages: BaseMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m instanceof HumanMessage) {
      lines.push(`用户：${contentToText(m.content)}`);
    } else if (m instanceof AIMessage) {
      const text = contentToText(m.content).trim();
      if (text) lines.push(`助手：${text}`);
      for (const call of m.tool_calls ?? []) {
        lines.push(`助手·调用工具 ${call.name}(${JSON.stringify(call.args)})`);
      }
    } else if (m instanceof ToolMessage) {
      const name = typeof m.name === "string" ? m.name : "tool";
      lines.push(`工具结果·${name}：${contentToText(m.content)}`);
    } else if (m instanceof SystemMessage) {
      // 系统提示由图每轮重新注入，无需进入摘要
      continue;
    }
  }
  return lines.join("\n");
}

/** 摘要提示词：要求模型产出可作为后续上下文的精简记录 */
export const SUMMARY_SYSTEM_PROMPT = `你是一个对话历史压缩器。请把下面这段较早的 code agent 对话压缩成简洁的中文摘要，供后续对话作为上下文。务必保留：
- 用户的核心目标与尚未完成的任务；
- 已做出的关键决定与结论；
- 已读取/创建/修改的重要文件路径与改动要点；
- 命令执行的关键结果（成败、报错要点）。
忽略寒暄与已无关的中间过程。只输出摘要正文，不要加前后缀说明。`;
