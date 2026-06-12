import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import type { StructuredToolInterface } from "@langchain/core/tools";
import {
  extOf,
  detectValidator,
  shellQuote,
  validateJsonText,
  validateYamlText,
  createValidateFileTool,
} from "../src/tools/validateFile.js";
import { createNoneBackend } from "../src/sandbox/backends/none.js";
import type { AppConfig } from "../src/config.js";

describe("extOf", () => {
  it("取小写扩展名（含点）", () => {
    expect(extOf("a/b/Foo.TS")).toBe(".ts");
    expect(extOf("script.py")).toBe(".py");
  });

  it("无扩展名返回空串", () => {
    expect(extOf("Makefile")).toBe("");
    expect(extOf("dir/README")).toBe("");
  });

  it("点开头的隐藏文件不算扩展名", () => {
    expect(extOf(".gitignore")).toBe("");
  });
});

describe("detectValidator", () => {
  it.each([
    ["a.ts", "typescript"],
    ["x.tsx", "typescript"],
    ["x.jsx", "typescript"],
    ["x.js", "javascript"],
    ["x.mjs", "javascript"],
    ["x.py", "python"],
    ["x.json", "json"],
    ["x.rb", "ruby"],
    ["x.sh", "shell"],
    ["x.go", "go"],
    ["Main.java", "java"],
    ["x.yaml", "yaml"],
    ["x.yml", "yaml"],
  ])("%s → %s", (name, kind) => {
    expect(detectValidator(name)?.kind).toBe(kind);
  });

  it("不支持的类型返回 null", () => {
    expect(detectValidator("x.txt")).toBeNull();
    expect(detectValidator("Makefile")).toBeNull();
  });
});

describe("shellQuote", () => {
  it("普通路径包单引号", () => {
    expect(shellQuote("/tmp/a.ts")).toBe("'/tmp/a.ts'");
  });

  it("含单引号的路径被正确转义", () => {
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
  });

  it("含空格的路径整体被包裹", () => {
    expect(shellQuote("/a b/c.ts")).toBe("'/a b/c.ts'");
  });
});

describe("validateJsonText", () => {
  it("合法 JSON 通过", () => {
    expect(validateJsonText('{"a":1}')).toEqual({ ok: true });
  });

  it("非法 JSON 返回错误信息", () => {
    const r = validateJsonText("{a:1}");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message.length).toBeGreaterThan(0);
  });
});

describe("validateYamlText", () => {
  it("合法 YAML 通过", () => {
    expect(validateYamlText("a: 1\nb:\n  - 2\n  - 3\n")).toEqual({ ok: true });
  });

  it("空文档通过", () => {
    expect(validateYamlText("")).toEqual({ ok: true });
  });

  it("缩进/结构错误返回错误信息", () => {
    // 同一映射里制表符 + 错误缩进导致解析失败
    const r = validateYamlText("a: 1\n  b: 2\n bad: : :\n");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message.length).toBeGreaterThan(0);
  });

  it("未闭合的流式集合返回错误信息", () => {
    const r = validateYamlText("a: [1, 2");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message.length).toBeGreaterThan(0);
  });
});

// ─────────────── 集成测试：真实调用 validate_file 校验各语言文件 ───────────────
// 校验器多依赖用户环境（tsc/python/ruby/go/javac/bash 等），故：
//   - 环境无关的（JSON/YAML 进程内、JavaScript 用 Node 自带 node --check）无条件断言；
//   - 其余用 it.runIf(可用) 条件运行：缺对应工具时跳过，避免在 CI/他机上 flaky。
// 探测在模块加载期同步进行（cwd=仓库根，能解析到本仓库已装的 tsc）。

function probe(cmd: string): boolean {
  try {
    execSync(cmd, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const HAS = {
  tsc: probe("npx --no-install tsc --version"),
  python: probe("python3 --version") || probe("python --version"),
  ruby: probe("ruby --version"),
  go: probe("go version"),
  javac: probe("javac -version"),
  shell: probe("bash --version"),
};

const FILES: Record<string, string> = {
  // 进程内 / Node 自带：无条件
  "good.json": '{"a":1,"b":[2,3]}\n',
  "bad.json": "{a:1}\n",
  "good.yaml": "name: demo\nitems:\n  - a\n  - b\n",
  "bad.yaml": "a: [1, 2\n",
  "good.js": "const x = 1;\nmodule.exports = x;\n",
  "bad.js": "const x = ;\n",
  // 环境相关
  "good.ts": "export const x: number = 1;\n",
  "bad.ts": "export const x: number = ;\n",
  "good.py": "x = 1\n",
  "bad.py": "def f(:\n    pass\n",
  "good.rb": "x = 1\nputs x\n",
  "bad.rb": "def f(\n",
  "good.go": "package main\n\nfunc main() {}\n",
  "bad.go": "package main\n\nfunc main({}\n",
  "Good.java": "public class Good { public static int f() { return 1; } }\n",
  "Bad.java": "public class Bad { int x = ; }\n",
  "good.sh": "#!/bin/bash\necho ok\n",
  "bad.sh": '#!/bin/bash\necho "oops\n',
  "note.txt": "not code\n",
};

const TEST_TIMEOUT = 60_000;

describe("validate_file 集成（真实校验）", () => {
  let workdir: string;
  let tool: StructuredToolInterface;

  const run = (path: string): Promise<string> =>
    tool.invoke({ path }) as Promise<string>;
  const expectPass = (out: string): void => expect(out).toContain("校验通过");
  const expectFail = (out: string): void => {
    expect(out).toContain("✗");
    expect(out).toContain("错误");
  };

  beforeAll(async () => {
    workdir = await mkdtemp(join(tmpdir(), "litecode-validate-"));
    // 软链本仓库 node_modules，使临时目录里的 `npx --no-install tsc` 能解析到 tsc
    try {
      await symlink(join(process.cwd(), "node_modules"), join(workdir, "node_modules"), "dir");
    } catch {
      /* 平台不支持目录软链时忽略：TS 用例会因此跳过或降级 */
    }
    await Promise.all(
      Object.entries(FILES).map(([name, content]) => writeFile(join(workdir, name), content)),
    );

    const config = {
      provider: { type: "anthropic", apiKey: "x", model: "m" },
      workdir,
      commandTimeoutMs: TEST_TIMEOUT,
      readFileMaxLines: 2000,
      commandOutputMaxBytes: 30 * 1024,
      maxIterations: 25,
      promptCaching: false,
      historyToolResultMaxBytes: 8192,
      historyCompactionMaxBytes: 60 * 1024,
      sandbox: {
        backend: "none",
        allowNetwork: true,
        writablePaths: [],
        limits: {},
        envPassthrough: [],
      },
    } as AppConfig;

    tool = createValidateFileTool(config, createNoneBackend()).tool;
  });

  afterAll(async () => {
    if (workdir) await rm(workdir, { recursive: true, force: true });
  });

  // ── 环境无关：无条件断言 ──
  it("JSON 合法通过 / 非法报错", async () => {
    expectPass(await run("good.json"));
    expectFail(await run("bad.json"));
  });

  it("YAML 合法通过 / 非法报错", async () => {
    expectPass(await run("good.yaml"));
    expectFail(await run("bad.yaml"));
  });

  it("JavaScript（node --check）合法通过 / 非法报错", async () => {
    expectPass(await run("good.js"));
    expectFail(await run("bad.js"));
  });

  // ── 环境相关：缺工具则跳过 ──
  it.runIf(HAS.tsc)(
    "TypeScript（tsc）合法通过 / 非法报错",
    async () => {
      expectPass(await run("good.ts"));
      expectFail(await run("bad.ts"));
    },
    TEST_TIMEOUT,
  );

  it.runIf(HAS.python)(
    "Python（ast.parse）合法通过 / 非法报错",
    async () => {
      expectPass(await run("good.py"));
      expectFail(await run("bad.py"));
    },
    TEST_TIMEOUT,
  );

  it.runIf(HAS.ruby)(
    "Ruby（ruby -c）合法通过 / 非法报错",
    async () => {
      expectPass(await run("good.rb"));
      expectFail(await run("bad.rb"));
    },
    TEST_TIMEOUT,
  );

  it.runIf(HAS.go)(
    "Go（gofmt -e）合法通过 / 非法报错",
    async () => {
      expectPass(await run("good.go"));
      expectFail(await run("bad.go"));
    },
    TEST_TIMEOUT,
  );

  it.runIf(HAS.javac)(
    "Java（单文件 javac）合法通过 / 非法报错",
    async () => {
      expectPass(await run("Good.java"));
      expectFail(await run("Bad.java"));
    },
    TEST_TIMEOUT,
  );

  it.runIf(HAS.shell)(
    "Shell（bash -n / shellcheck）合法通过 / 非法报错",
    async () => {
      expectPass(await run("good.sh"));
      expectFail(await run("bad.sh"));
    },
    TEST_TIMEOUT,
  );

  // ── 边界 ──
  it("不支持的类型 → 跳过校验", async () => {
    expect(await run("note.txt")).toContain("跳过校验");
  });

  it("文件不存在 → 报错", async () => {
    expect(await run("nope.ts")).toContain("文件不存在");
  });

  it("路径越界 → 拒绝", async () => {
    expect(await run("../../etc/passwd")).toContain("超出");
  });
});
