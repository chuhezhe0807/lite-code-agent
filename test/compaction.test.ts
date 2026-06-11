import { describe, it, expect } from "vitest";
import {
  HumanMessage,
  AIMessage,
  ToolMessage,
} from "@langchain/core/messages";
import {
  totalBytes,
  estimateMessageBytes,
  planCompaction,
  applyCompaction,
  renderTranscript,
} from "../src/agent/compaction.js";

const big = (n: number) => "x".repeat(n);

function sampleHistory() {
  return [
    new HumanMessage("q0"), // 0
    new AIMessage("a0"), // 1
    new ToolMessage({ content: big(2000), tool_call_id: "c0", name: "read_file" }), // 2
    new HumanMessage("q1"), // 3
    new AIMessage("a1"), // 4
    new ToolMessage({ content: big(2000), tool_call_id: "c1", name: "read_file" }), // 5
    new HumanMessage("q2-recent"), // 6
  ];
}

describe("estimateMessageBytes / totalBytes", () => {
  it("含 tool_calls 的 AIMessage 计入 JSON 字节", () => {
    const ai = new AIMessage({
      content: "hi",
      tool_calls: [{ name: "read_file", args: { path: "a" }, id: "c" }],
    });
    expect(estimateMessageBytes(ai)).toBeGreaterThan(2);
  });
  it("totalBytes 为各条之和", () => {
    const msgs = [new HumanMessage("ab"), new AIMessage("cde")];
    expect(totalBytes(msgs)).toBe(5);
  });
});

describe("planCompaction", () => {
  it("maxBytes=0 不压缩", () => {
    expect(planCompaction(sampleHistory(), 0)).toBeNull();
  });
  it("未超阈值不压缩", () => {
    expect(planCompaction(sampleHistory(), 1_000_000)).toBeNull();
  });
  it("只有 index 0 一个 Human 边界时无法切分", () => {
    const msgs = [new HumanMessage(big(5000)), new AIMessage("a")];
    expect(planCompaction(msgs, 100)).toBeNull();
  });
  it("超阈值时切在 Human 边界，保留段尽量压到预算内", () => {
    const plan = planCompaction(sampleHistory(), 1500, 0.5);
    expect(plan).not.toBeNull();
    // 保留最近一轮（idx 6 的 Human）
    expect(plan!.cut).toBe(6);
  });
  it("cut 一定指向 HumanMessage", () => {
    const msgs = sampleHistory();
    const plan = planCompaction(msgs, 1500, 0.5)!;
    expect(msgs[plan.cut]).toBeInstanceOf(HumanMessage);
  });
});

describe("applyCompaction", () => {
  it("摘要折叠进保留段首条用户消息，其余原样", () => {
    const msgs = sampleHistory();
    const out = applyCompaction(msgs, 3, "这是摘要");
    // 保留段 messages[3..] 共 4 条，折叠后仍是 4 条
    expect(out).toHaveLength(4);
    expect(out[0]).toBeInstanceOf(HumanMessage);
    const firstText = out[0].content as string;
    expect(firstText).toContain("这是摘要");
    expect(firstText).toContain("q1"); // 原首条用户消息文本保留
    // 后续 AI/工具消息原样
    expect(out[1]).toBeInstanceOf(AIMessage);
    expect(out[2]).toBeInstanceOf(ToolMessage);
  });

  it("压缩后不破坏 tool_use/tool_result 配对（无孤儿 tool_result）", () => {
    const msgs = sampleHistory();
    const out = applyCompaction(msgs, 3, "S");
    // 首条不能是 ToolMessage（否则就是孤儿 tool_result）
    expect(out[0]).not.toBeInstanceOf(ToolMessage);
  });
});

describe("renderTranscript", () => {
  it("按角色转写并标注工具调用/结果", () => {
    const ai = new AIMessage({
      content: "思考",
      tool_calls: [{ name: "read_file", args: { path: "a" }, id: "c" }],
    });
    const t = renderTranscript([
      new HumanMessage("目标"),
      ai,
      new ToolMessage({ content: "内容", tool_call_id: "c", name: "read_file" }),
    ]);
    expect(t).toContain("用户：目标");
    expect(t).toContain("助手：思考");
    expect(t).toContain("调用工具 read_file");
    expect(t).toContain("工具结果·read_file：内容");
  });
});
