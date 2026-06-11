import { describe, it, expect } from "vitest";
import {
  parseRule,
  matchPattern,
  matchesAny,
  generalizeRule,
} from "../src/permissions/match.js";

describe("parseRule", () => {
  it("解析 工具名(模式)", () => {
    expect(parseRule("run_command(npx tsc *)")).toEqual({
      toolName: "run_command",
      pattern: "npx tsc *",
    });
  });
  it("非法格式返回 null", () => {
    expect(parseRule("no-parens")).toBeNull();
  });
});

describe("matchPattern", () => {
  it("* 通配匹配任意字符", () => {
    expect(matchPattern("npx tsc *", "npx tsc --noEmit")).toBe(true);
  });
  it("整体锚定：前缀不同不匹配", () => {
    expect(matchPattern("npx tsc *", "yarn tsc x")).toBe(false);
  });
  it("元字符按字面匹配（点号不当通配）", () => {
    expect(matchPattern("a.b", "aXb")).toBe(false);
    expect(matchPattern("a.b", "a.b")).toBe(true);
  });
  it("无 * 时要求完全相等", () => {
    expect(matchPattern("ls", "ls")).toBe(true);
    expect(matchPattern("ls", "ls -la")).toBe(false);
  });
});

describe("matchesAny", () => {
  const rules = ["run_command(npm test *)", "write_file(src/*)"];
  it("命中工具名+模式", () => {
    expect(matchesAny(rules, "run_command", "npm test --watch")).toBe(true);
  });
  it("工具名不符不命中", () => {
    expect(matchesAny(rules, "edit_file", "src/a.ts")).toBe(false);
  });
  it("模式不符不命中", () => {
    expect(matchesAny(rules, "write_file", "lib/a.ts")).toBe(false);
  });
});

describe("generalizeRule", () => {
  it("execute：保留命令首段 + *", () => {
    expect(generalizeRule("run_command", "execute", "npx tsc --noEmit")).toBe(
      "run_command(npx tsc *)",
    );
  });
  it("execute：第二段是选项则只保留首 token", () => {
    expect(generalizeRule("run_command", "execute", "ls -la")).toBe(
      "run_command(ls *)",
    );
  });
  it("write：按所在目录泛化", () => {
    expect(generalizeRule("write_file", "write", "src/a/b.ts")).toBe(
      "write_file(src/a/*)",
    );
  });
  it("write：根目录文件用 *", () => {
    expect(generalizeRule("write_file", "write", "foo.ts")).toBe(
      "write_file(*)",
    );
  });
});
