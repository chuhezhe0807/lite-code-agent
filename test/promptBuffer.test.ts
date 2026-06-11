import { describe, it, expect } from "vitest";
import * as buf from "../src/cli/promptBuffer.js";

describe("promptBuffer 编辑", () => {
  it("insert 在 caret 处插入并前移光标", () => {
    expect(buf.insert("ab", 1, "X")).toEqual({ text: "aXb", caret: 2 });
  });

  it("insert 多字符（emoji 按单 code point）", () => {
    const r = buf.insert("", 0, "😀好");
    expect(r.text).toBe("😀好");
    expect(r.caret).toBe(2); // 两个 code point
  });

  it("backspaceChar 删 caret 前一个字符", () => {
    expect(buf.backspaceChar("abc", 2)).toEqual({ text: "ac", caret: 1 });
  });

  it("backspaceChar 在行首不动", () => {
    expect(buf.backspaceChar("abc", 0)).toEqual({ text: "abc", caret: 0 });
  });

  it("backspaceChar 不破坏 emoji", () => {
    expect(buf.backspaceChar("a😀", 2)).toEqual({ text: "a", caret: 1 });
  });

  it("deleteChar 向后删", () => {
    expect(buf.deleteChar("abc", 1)).toEqual({ text: "ac", caret: 1 });
  });

  it("deleteChar 在末尾不动", () => {
    expect(buf.deleteChar("abc", 3)).toEqual({ text: "abc", caret: 3 });
  });
});

describe("promptBuffer 按词删除/移动", () => {
  it("deleteWordBefore 删前一个词", () => {
    const r = buf.deleteWordBefore("foo bar", 7);
    expect(r.text).toBe("foo ");
    expect(r.caret).toBe(4);
    expect(r.killed).toBe("bar");
  });

  it("deleteWordBefore 跳过紧邻空白", () => {
    const r = buf.deleteWordBefore("foo bar  ", 9);
    expect(r.text).toBe("foo ");
    expect(r.killed).toBe("bar  ");
  });

  it("deleteWordAfter 删后一个词", () => {
    const r = buf.deleteWordAfter("foo bar", 0);
    expect(r.text).toBe(" bar");
    expect(r.killed).toBe("foo");
  });

  it("moveWordLeft / moveWordRight", () => {
    expect(buf.moveWordLeft("foo bar", 7)).toBe(4);
    expect(buf.moveWordRight("foo bar", 0)).toBe(3);
  });
});

describe("promptBuffer 行首/行尾删除", () => {
  it("deleteToLineStart 删到逻辑行首", () => {
    const r = buf.deleteToLineStart("hello world", 11);
    expect(r.text).toBe("");
    expect(r.caret).toBe(0);
    expect(r.killed).toBe("hello world");
  });

  it("deleteToLineStart 紧邻换行只删换行", () => {
    const r = buf.deleteToLineStart("a\nb", 2);
    expect(r.text).toBe("ab");
    expect(r.caret).toBe(1);
    expect(r.killed).toBe("\n");
  });

  it("deleteToLineStart 多行只删当前行前半", () => {
    const r = buf.deleteToLineStart("foo\nbar baz", 11);
    expect(r.text).toBe("foo\n");
    expect(r.killed).toBe("bar baz");
  });

  it("deleteToLineEnd 删到逻辑行尾", () => {
    const r = buf.deleteToLineEnd("hello world", 5);
    expect(r.text).toBe("hello");
    expect(r.killed).toBe(" world");
  });

  it("deleteToLineEnd 在换行上只删换行", () => {
    const r = buf.deleteToLineEnd("a\nb", 1);
    expect(r.text).toBe("ab");
    expect(r.killed).toBe("\n");
  });
});

describe("promptBuffer 折行 wrapLines", () => {
  it("窄于列宽时单行", () => {
    const lines = buf.wrapLines("hello", 2, 80);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ startCaret: 0, length: 5 });
  });

  it("超过可用宽度软换行（首行预留 prefix）", () => {
    // cols=10, prefix=2 → 首行可用 8；后续行可用 10
    const lines = buf.wrapLines("abcdefghijabc", 2, 10);
    expect(lines[0]).toMatchObject({ startCaret: 0, length: 8 });
    expect(lines[1]!.startCaret).toBe(8);
  });

  it("显式换行切行且不计入内容", () => {
    const lines = buf.wrapLines("ab\ncd", 2, 80);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ startCaret: 0, length: 2 });
    expect(lines[1]).toMatchObject({ startCaret: 3, length: 2 }); // 跳过 \n
  });

  it("空文本至少一行", () => {
    const lines = buf.wrapLines("", 2, 80);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ startCaret: 0, length: 0 });
  });

  it("宽字符（中文）按宽度 2 折行", () => {
    // cols=6, prefix=0 → 每个中文宽 2，最多 3 个/行
    const lines = buf.wrapLines("中文测试", 0, 6);
    expect(lines[0]!.length).toBe(3);
    expect(lines[1]!.startCaret).toBe(3);
  });
});

describe("promptBuffer 光标定位 locateCaret", () => {
  it("单行：col 含 prefix 宽度", () => {
    expect(buf.locateCaret("abc", 2, 2, 80)).toEqual({ row: 0, col: 4 });
  });

  it("行首 caret=0", () => {
    expect(buf.locateCaret("abc", 0, 2, 80)).toEqual({ row: 0, col: 2 });
  });

  it("换行后定位到下一行 col 不含 prefix", () => {
    const pos = buf.locateCaret("ab\ncd", 4, 2, 80); // caret 在第二行 'd' 前
    expect(pos).toEqual({ row: 1, col: 1 });
  });

  it("软换行后定位正确", () => {
    // cols=10 prefix=2 首行 8 个，caret=8 落到第二行行首
    const pos = buf.locateCaret("abcdefghij", 8, 2, 10);
    expect(pos).toEqual({ row: 1, col: 0 });
  });

  it("中文列宽计入 col", () => {
    expect(buf.locateCaret("中a", 1, 0, 80)).toEqual({ row: 0, col: 2 });
  });
});

describe("promptBuffer 跨行移动", () => {
  it("moveUp 在首行返回 null", () => {
    expect(buf.moveUp("abc", 1, 2, 80)).toBeNull();
  });

  it("moveDown 在末行返回 null", () => {
    expect(buf.moveDown("abc", 1, 2, 80)).toBeNull();
  });

  it("moveDown 进入下一逻辑行并尽量保持列", () => {
    // "abc\ndefg"：caret=2（'c'前，col=2+2=4），下移到第二行约第 col 列
    const next = buf.moveDown("abc\ndefg", 2, 2, 80);
    expect(next).not.toBeNull();
    const pos = buf.locateCaret("abc\ndefg", next!, 2, 80);
    expect(pos.row).toBe(1);
  });

  it("moveUp 从第二行回到第一行", () => {
    const next = buf.moveUp("abc\ndefg", 6, 2, 80);
    expect(next).not.toBeNull();
    expect(buf.locateCaret("abc\ndefg", next!, 2, 80).row).toBe(0);
  });
});
