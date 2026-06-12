import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../src/cli/markdown.js";

// 测试环境 stdout 非 TTY，chalk 关闭颜色，输出为纯文本，便于断言。
// 这里只校验「结构被解析、语法标记被消化、无尾部空行」，不断言具体 ANSI。
const strip = (s: string): string => s.replace(/\[[0-9;]*m/g, "");

describe("renderMarkdown", () => {
  it("粗体/行内代码标记被消化，保留文字内容", () => {
    const out = strip(renderMarkdown("这是 **粗体** 与 `code`。", 80));
    expect(out).toContain("粗体");
    expect(out).toContain("code");
    expect(out).not.toContain("**");
    expect(out).not.toContain("`");
  });

  it("列表项被渲染", () => {
    const out = strip(renderMarkdown("- 项一\n- 项二", 80));
    expect(out).toContain("项一");
    expect(out).toContain("项二");
  });

  it("标题保留文字", () => {
    const out = strip(renderMarkdown("# 大标题", 80));
    expect(out).toContain("大标题");
  });

  it("表格被渲染（含表头与单元格）", () => {
    const md = "| 用例 | 结果 |\n|---|---|\n| a | 通过 |";
    const out = strip(renderMarkdown(md, 80));
    expect(out).toContain("用例");
    expect(out).toContain("通过");
  });

  it("去掉尾部空行", () => {
    const out = renderMarkdown("段落", 80);
    expect(out).toBe(out.replace(/\s+$/, ""));
    expect(out.endsWith("\n")).toBe(false);
  });

  it("纯文本原样保留", () => {
    const out = strip(renderMarkdown("just plain text", 80));
    expect(out).toContain("just plain text");
  });
});
