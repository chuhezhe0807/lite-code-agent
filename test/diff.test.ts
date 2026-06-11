import { describe, it, expect } from "vitest";
import { formatReplaceDiff } from "../src/util/diff.js";

describe("formatReplaceDiff", () => {
  it("旧行加 - 前缀、新行加 + 前缀", () => {
    expect(formatReplaceDiff("a", "b")).toBe("- a\n+ b");
  });
  it("多行各自加前缀", () => {
    expect(formatReplaceDiff("a\nb", "c\nd")).toBe("- a\n- b\n+ c\n+ d");
  });
  it("空字符串也成行", () => {
    expect(formatReplaceDiff("", "x")).toBe("- \n+ x");
  });
});
