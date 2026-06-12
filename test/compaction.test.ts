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
  repairToolPairs,
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

describe("repairToolPairs", () => {
  const aiCall = (id: string, name = "edit_file") =>
    new AIMessage({ content: "改一下", tool_calls: [{ name, args: {}, id }] });

  it("强制停止遗留的悬空 tool_use 后跟 Human：在 AI 正后面补占位 tool_result", () => {
    const msgs = [
      new HumanMessage("q0"),
      aiCall("toolu_1"), // 悬空：工具未执行
      new HumanMessage("继续"),
    ];
    const fixed = repairToolPairs(msgs);
    // 顺序应为 Human, AI(tool_use), ToolMessage(占位), Human
    expect(fixed).toHaveLength(4);
    expect(fixed[2]).toBeInstanceOf(ToolMessage);
    expect((fixed[2] as ToolMessage).tool_call_id).toBe("toolu_1");
    expect(fixed[3]).toBeInstanceOf(HumanMessage);
  });

  it("已正确配对的序列保持不变", () => {
    const msgs = [
      new HumanMessage("q"),
      aiCall("c1"),
      new ToolMessage({ content: "ok", tool_call_id: "c1", name: "edit_file" }),
      new AIMessage("done"),
    ];
    const fixed = repairToolPairs(msgs);
    expect(fixed).toHaveLength(4);
    expect(fixed).toEqual(msgs);
  });

  it("丢弃没有前驱 tool_use 的孤儿 tool_result", () => {
    const msgs = [
      new ToolMessage({ content: "孤儿", tool_call_id: "x", name: "read_file" }),
      new HumanMessage("hi"),
    ];
    const fixed = repairToolPairs(msgs);
    expect(fixed).toHaveLength(1);
    expect(fixed[0]).toBeInstanceOf(HumanMessage);
  });

  it("一条 AI 多个 call 只补未解决的那个", () => {
    const ai = new AIMessage({
      content: "",
      tool_calls: [
        { name: "edit_file", args: {}, id: "a" },
        { name: "read_file", args: {}, id: "b" },
      ],
    });
    const msgs = [
      new HumanMessage("q"),
      ai,
      new ToolMessage({ content: "a 的结果", tool_call_id: "a", name: "edit_file" }),
      new HumanMessage("next"),
    ];
    const fixed = repairToolPairs(msgs);
    // a 已有结果保留，b 补占位；二者都在 AI 正后面、Human 之前
    const ids = fixed
      .filter((m): m is ToolMessage => m instanceof ToolMessage)
      .map((m) => m.tool_call_id);
    expect(ids).toEqual(["a", "b"]);
    expect(fixed[fixed.length - 1]).toBeInstanceOf(HumanMessage);
  });
});
