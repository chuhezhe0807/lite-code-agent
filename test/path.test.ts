import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import {
  resolveSafePath,
  isPathInside,
  PathAccessError,
} from "../src/security/path.js";

const workdir = resolve("/tmp/workdir");

describe("resolveSafePath", () => {
  it("解析 workdir 内的相对路径", () => {
    expect(resolveSafePath(workdir, "src/a.ts")).toBe(
      resolve(workdir, "src/a.ts"),
    );
  });

  it("接受 workdir 内的绝对路径", () => {
    const p = resolve(workdir, "x/y.ts");
    expect(resolveSafePath(workdir, p)).toBe(p);
  });

  it("拒绝越界的相对路径（..）", () => {
    expect(() => resolveSafePath(workdir, "../secret")).toThrow(PathAccessError);
  });

  it("拒绝 workdir 之外的绝对路径", () => {
    expect(() => resolveSafePath(workdir, "/etc/passwd")).toThrow(
      PathAccessError,
    );
  });

  it("workdir 根（.）本身合法", () => {
    expect(resolveSafePath(workdir, ".")).toBe(workdir);
  });
});

describe("isPathInside", () => {
  it("内部路径返回 true", () => {
    expect(isPathInside(workdir, "a/b.ts")).toBe(true);
  });
  it("越界路径返回 false", () => {
    expect(isPathInside(workdir, "../../x")).toBe(false);
  });
});
