import { describe, it, expect } from "vitest";
import {
  HumanMessage,
  AIMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { sanitizeForResume } from "../src/cli/controller.js";

describe("sanitizeForResume", () => {
  it("为悬空的 tool_call 合成「已被用户中断」的 ToolMessage", () => {
    const ai = new AIMessage({
      content: "",
      tool_calls: [
        { name: "read_file", args: { path: "a.ts" }, id: "call_1" },
        { name: "run_command", args: { command: "ls" }, id: "call_2" },
      ],
    });
    const messages = [new HumanMessage("做点事"), ai];
    const out = sanitizeForResume(messages);

    // 原 2 条 + 2 条合成
    expect(out).toHaveLength(4);
    const synthesized = out.slice(2) as ToolMessage[];
    expect(synthesized.every((m) => m instanceof ToolMessage)).toBe(true);
    expect(synthesized.map((m) => m.tool_call_id).sort()).toEqual([
      "call_1",
      "call_2",
    ]);
    expect(synthesized[0].content).toContain("中断");
  });

  it("已有 tool_result 的 tool_call 不重复合成", () => {
    const ai = new AIMessage({
      content: "",
      tool_calls: [
        { name: "read_file", args: { path: "a.ts" }, id: "call_1" },
        { name: "run_command", args: { command: "ls" }, id: "call_2" },
      ],
    });
    const resolved = new ToolMessage({
      content: "文件内容",
      tool_call_id: "call_1",
      name: "read_file",
    });
    const out = sanitizeForResume([new HumanMessage("x"), ai, resolved]);

    // 只为未解决的 call_2 合成 1 条
    expect(out).toHaveLength(4);
    const last = out[out.length - 1] as ToolMessage;
    expect(last).toBeInstanceOf(ToolMessage);
    expect(last.tool_call_id).toBe("call_2");
  });

  it("没有悬空 tool_call 时原样返回", () => {
    const messages = [new HumanMessage("纯聊天"), new AIMessage("你好")];
    expect(sanitizeForResume(messages)).toHaveLength(2);
  });
});
