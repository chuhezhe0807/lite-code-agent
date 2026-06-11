import { describe, it, expect } from "vitest";
import {
  globToRegExp,
  createGlobMatcher,
  toPosix,
} from "../src/util/glob.js";

describe("globToRegExp", () => {
  it("* 不跨目录", () => {
    const re = globToRegExp("*.ts");
    expect(re.test("a.ts")).toBe(true);
    expect(re.test("dir/a.ts")).toBe(false);
  });
  it("**/ 匹配零或多个目录层级", () => {
    const re = globToRegExp("**/*.ts");
    expect(re.test("a.ts")).toBe(true);
    expect(re.test("src/a.ts")).toBe(true);
    expect(re.test("src/x/a.ts")).toBe(true);
  });
  it("固定前缀 + **/", () => {
    const re = globToRegExp("src/**/*.tsx");
    expect(re.test("src/a.tsx")).toBe(true);
    expect(re.test("src/x/a.tsx")).toBe(true);
    expect(re.test("lib/a.tsx")).toBe(false);
  });
  it("? 匹配单个非斜杠字符", () => {
    const re = globToRegExp("a?.ts");
    expect(re.test("ab.ts")).toBe(true);
    expect(re.test("a/.ts")).toBe(false);
  });
  it("元字符按字面转义", () => {
    const re = globToRegExp("a.b");
    expect(re.test("a.b")).toBe(true);
    expect(re.test("aXb")).toBe(false);
  });
});

describe("createGlobMatcher", () => {
  it("无 / 的模式按 basename 匹配任意层级", () => {
    const m = createGlobMatcher("*.ts");
    expect(m("a.ts")).toBe(true);
    expect(m("src/deep/a.ts")).toBe(true);
    expect(m("a.tsx")).toBe(false);
  });
  it("含 / 的模式按完整相对路径匹配", () => {
    const m = createGlobMatcher("src/**/*.ts");
    expect(m("src/a.ts")).toBe(true);
    expect(m("lib/a.ts")).toBe(false);
  });
});

describe("toPosix", () => {
  it("反斜杠统一为正斜杠", () => {
    expect(toPosix("a\\b\\c")).toBe("a/b/c");
  });
});
