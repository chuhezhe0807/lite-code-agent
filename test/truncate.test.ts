import { describe, it, expect } from "vitest";
import { truncateHeadTail } from "../src/util/truncate.js";

describe("truncateHeadTail", () => {
  it("未超预算时原样返回", () => {
    const text = "line1\nline2";
    expect(truncateHeadTail(text, { maxBytes: 1000 })).toBe(text);
  });

  it("多行超预算时保留头尾 + 省略中间行", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line${i}`);
    const out = truncateHeadTail(lines.join("\n"), {
      maxBytes: 10,
      headLines: 2,
      tailLines: 2,
    });
    expect(out).toContain("line0");
    expect(out).toContain("line1");
    expect(out).toContain("line199");
    expect(out).toContain("省略中间");
    // 省略了 200 - 2 - 2 = 196 行
    expect(out).toContain("196 行");
  });

  it("单行超长退化为按字符头尾硬截断", () => {
    const text = "x".repeat(1000);
    const out = truncateHeadTail(text, {
      maxBytes: 100,
      headLines: 50,
      tailLines: 50,
    });
    expect(out).toContain("省略中间");
    expect(out).toContain("字节");
    expect(out.length).toBeLessThan(text.length);
  });
});
