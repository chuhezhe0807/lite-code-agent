/**
 * validate_file 工具：在编辑/写入代码文件后，校验该文件是否存在编译 / 语法错误。
 *
 * 设计要点：
 *   - 按文件扩展名选择对应语言的校验器（tsc / node --check / python ast / JSON / ruby -c /
 *     shellcheck|bash -n / gofmt）。
 *   - **优雅降级**：外部校验器需先探测是否安装（跑一次 `--version` 之类）；未安装则
 *     「跳过校验」而非报错，避免阻塞 agent（用户环境千差万别）。JSON 在进程内用
 *     JSON.parse 校验，JavaScript 用随 Node 自带的 `node --check`，二者永不缺失。
 *   - 只读、无副作用：所有校验命令都不修改文件（py 用 ast.parse 而非 py_compile，
 *     避免写出 __pycache__；gofmt -e 仅打印不写回）。因此授权级别定为 read，
 *     便于在每次编辑后无摩擦地调用。
 *   - 复用沙箱执行器（runInSandbox）：cwd 锁定工作目录、超时杀进程、透传 Esc 中断。
 *   - 路径经 resolveSafePath 校验，越界拒绝。
 *
 * 注：命令里的文件路径用 POSIX 单引号包裹（shellQuote）。本工具主要面向 macOS/Linux；
 * Windows + cmd.exe 下单引号语义不同，属已知边界。
 */

import { readFile, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { tool } from "@langchain/core/tools";
import type { AppConfig } from "../config.js";
import { resolveSafePath, PathAccessError } from "../security/path.js";
import { runInSandbox } from "../sandbox/exec.js";
import { buildSandboxPolicy } from "../sandbox/policy.js";
import type { SandboxBackend } from "../sandbox/types.js";
import { truncateHeadTail } from "../util/truncate.js";
import type { ToolSpec } from "./types.js";

/** 校验器种类 */
export type ValidatorKind =
  | "typescript"
  | "javascript"
  | "python"
  | "json"
  | "ruby"
  | "shell"
  | "go"
  | "java"
  | "yaml";

/** 校验器定义（仅静态元数据，命令构造在执行时按种类分派） */
export interface Validator {
  kind: ValidatorKind;
  /** 中文语言名，用于结果展示 */
  label: string;
  /** 命中的扩展名（含点，小写） */
  exts: string[];
}

/** 扩展名 → 校验器。顺序即优先级（同扩展名只会命中第一个）。 */
export const VALIDATORS: Validator[] = [
  // .jsx/.tsx 交给 tsc（能解析 JSX）；纯 .js 用 node --check
  { kind: "typescript", label: "TypeScript", exts: [".ts", ".mts", ".cts", ".tsx", ".jsx"] },
  { kind: "javascript", label: "JavaScript", exts: [".js", ".mjs", ".cjs"] },
  { kind: "python", label: "Python", exts: [".py", ".pyi"] },
  { kind: "json", label: "JSON", exts: [".json"] },
  { kind: "ruby", label: "Ruby", exts: [".rb"] },
  { kind: "shell", label: "Shell", exts: [".sh", ".bash"] },
  { kind: "go", label: "Go", exts: [".go"] },
  { kind: "java", label: "Java", exts: [".java"] },
  { kind: "yaml", label: "YAML", exts: [".yaml", ".yml"] },
];

/** 取文件名的小写扩展名（含点）；无扩展名返回空串。 */
export function extOf(filename: string): string {
  const base = filename.slice(filename.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

/** 按文件名匹配校验器；不支持的类型返回 null。 */
export function detectValidator(filename: string): Validator | null {
  const ext = extOf(filename);
  if (!ext) return null;
  return VALIDATORS.find((v) => v.exts.includes(ext)) ?? null;
}

/** POSIX 单引号转义：把字符串安全地包进 '...'。 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** JSON 文本进程内校验（无需外部工具）。 */
export function validateJsonText(text: string): { ok: true } | { ok: false; message: string } {
  try {
    JSON.parse(text);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

/** YAML 文本进程内校验（用 yaml 库，无需外部工具）。 */
export function validateYamlText(text: string): { ok: true } | { ok: false; message: string } {
  try {
    parseYaml(text);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

const schema = z.object({
  path: z.string().describe("要校验的代码文件路径（相对工作目录或绝对路径）"),
});

/**
 * 创建 validate_file 工具。
 * @param config 应用配置（提供 workdir、超时）
 * @param backend 沙箱后端（与 run_command 共用，用于包裹校验命令）
 */
export function createValidateFileTool(
  config: AppConfig,
  backend: SandboxBackend,
): ToolSpec {
  const policy = buildSandboxPolicy(config);

  /** 在沙箱中执行一条命令，返回 { code, output }。 */
  const run = async (
    command: string,
    signal: AbortSignal | undefined,
  ): Promise<{ code: number | null; output: string; spawnError?: string }> => {
    const result = await runInSandbox(command, {
      cwd: config.workdir,
      timeoutMs: config.commandTimeoutMs,
      backend,
      policy,
      signal,
      maxAccumulateBytes: config.commandOutputMaxBytes * 4,
    });
    const budget = { maxBytes: config.commandOutputMaxBytes };
    const out = [result.stdout, result.stderr]
      .map((s) => truncateHeadTail(s, budget))
      .filter((s) => s.trim().length > 0)
      .join("\n");
    return { code: result.code, output: out, spawnError: result.spawnError };
  };

  /** 探测某命令是否可用（退出码 0 视为可用）。 */
  const isAvailable = async (probe: string, signal: AbortSignal | undefined): Promise<boolean> => {
    const r = await run(probe, signal);
    return !r.spawnError && r.code === 0;
  };

  const validateFileTool = tool(
    async (input, runnableConfig): Promise<string> => {
      const { path } = input;
      const signal = runnableConfig?.signal;

      // 1. 路径安全校验
      let absPath: string;
      try {
        absPath = resolveSafePath(config.workdir, path);
      } catch (err) {
        if (err instanceof PathAccessError) return `错误：${err.message}`;
        throw err;
      }
      if (!existsSync(absPath)) {
        return `错误：文件不存在：'${path}'。`;
      }
      const rel = relative(config.workdir, absPath) || path;

      // 2. 选择校验器
      const v = detectValidator(absPath);
      if (!v) {
        const supported = [...new Set(VALIDATORS.flatMap((x) => x.exts))].join(" ");
        return `跳过校验：暂不支持该文件类型（${extOf(absPath) || "无扩展名"}）。支持：${supported}`;
      }

      const q = shellQuote(absPath);
      const skipped = (tip: string): string =>
        `跳过校验：未检测到 ${v.label} 校验器，已降级（不报告错误）。${tip}`;
      const passed = `✓ ${rel} 校验通过（${v.label}）。`;
      const failed = (out: string): string =>
        `✗ ${rel} 存在 ${v.label} 编译/语法错误：\n${out || "(校验器未输出详情)"}`;

      // 3. 按种类分派
      switch (v.kind) {
        case "json": {
          // 进程内校验，无需外部工具
          const text = await readFile(absPath, "utf-8");
          const r = validateJsonText(text);
          return r.ok ? passed : failed(r.message);
        }

        case "yaml": {
          // 进程内校验（yaml 库），无需外部工具
          const text = await readFile(absPath, "utf-8");
          const r = validateYamlText(text);
          return r.ok ? passed : failed(r.message);
        }

        case "javascript": {
          // node 必然存在（本程序就跑在 node 上）
          const r = await run(`node --check ${q}`, signal);
          return r.code === 0 ? passed : failed(r.output);
        }

        case "typescript": {
          if (!(await isAvailable("npx --no-install tsc --version", signal))) {
            return skipped("可在项目中安装 typescript（如 npm i -D typescript）后重试。");
          }
          // 有 tsconfig.json 时按「项目」校验（尊重项目配置、结果准确，会一并报出项目内其它错误）；
          // 否则退化为单文件校验（宽松开启 jsx/allowJs 以兼容 .jsx/.tsx）。
          const hasTsconfig = existsSync(join(config.workdir, "tsconfig.json"));
          const cmd = hasTsconfig
            ? "npx --no-install tsc --noEmit -p tsconfig.json"
            : `npx --no-install tsc --noEmit --skipLibCheck --jsx preserve --allowJs ${q}`;
          const r = await run(cmd, signal);
          if (r.code === 0) {
            return hasTsconfig ? `✓ ${rel} 校验通过（${v.label}，项目级 tsc）。` : passed;
          }
          return failed(r.output) + (hasTsconfig ? "\n（注：项目级校验，错误可能来自其它文件）" : "");
        }

        case "python": {
          const py = (await isAvailable("python3 --version", signal))
            ? "python3"
            : (await isAvailable("python --version", signal))
              ? "python"
              : null;
          if (!py) return skipped("可安装 Python 3 后重试。");
          // 用 ast.parse 做纯语法校验，不写出 .pyc
          const script =
            'import ast,sys; ast.parse(open(sys.argv[1],encoding="utf-8").read(), sys.argv[1])';
          const r = await run(`${py} -c ${shellQuote(script)} ${q}`, signal);
          return r.code === 0 ? passed : failed(r.output);
        }

        case "ruby": {
          if (!(await isAvailable("ruby --version", signal))) {
            return skipped("可安装 Ruby 后重试。");
          }
          const r = await run(`ruby -c ${q}`, signal);
          return r.code === 0 ? passed : failed(r.output);
        }

        case "shell": {
          // 优先 shellcheck（更全面），否则退回 bash -n（仅语法）
          if (await isAvailable("shellcheck --version", signal)) {
            const r = await run(`shellcheck ${q}`, signal);
            return r.code === 0 ? passed : failed(r.output);
          }
          if (await isAvailable("bash --version", signal)) {
            const r = await run(`bash -n ${q}`, signal);
            return r.code === 0 ? passed : failed(r.output);
          }
          return skipped("可安装 shellcheck 或 bash 后重试。");
        }

        case "go": {
          if (!(await isAvailable("go version", signal))) {
            return skipped("可安装 Go 后重试。");
          }
          const r = await run(`gofmt -e ${q}`, signal);
          return r.code === 0 ? passed : failed(r.output);
        }

        case "java": {
          const hasPom = existsSync(join(config.workdir, "pom.xml"));
          const hasGradle = ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"].some(
            (f) => existsSync(join(config.workdir, f)),
          );

          // 单文件 javac 校验（项目构建不可用时的回退）；不可用返回 null。
          const singleFileJavac = async (): Promise<string | null> => {
            if (!(await isAvailable("javac -version", signal))) return null;
            // 编译产物写到临时目录，避免在工作目录里散落 .class；用完即删。
            const outDir = await mkdtemp(join(tmpdir(), "litecode-javac-"));
            try {
              const r = await run(`javac -d ${shellQuote(outDir)} ${q}`, signal);
              if (r.code === 0) return passed;
              return failed(r.output) + "\n（注：单文件 javac 校验，若文件依赖外部类/库可能误报）";
            } finally {
              await rm(outDir, { recursive: true, force: true });
            }
          };

          // Maven 项目：用 mvn 编译整个项目（结果准确，会一并报出项目内其它错误）。优先用项目自带 ./mvnw。
          if (hasPom) {
            const wrapper = existsSync(join(config.workdir, "mvnw"));
            const mvn = wrapper ? "./mvnw" : "mvn";
            if (wrapper || (await isAvailable("mvn -version", signal))) {
              const r = await run(`${mvn} -q compile`, signal);
              if (r.code === 0) return `✓ ${rel} 校验通过（${v.label}，Maven 项目编译）。`;
              return failed(r.output) + "\n（注：Maven 项目级编译，错误可能来自其它文件）";
            }
          }

          // Gradle 项目：用 gradle 编译 Java 源（优先 ./gradlew）。
          if (hasGradle) {
            const wrapper = existsSync(join(config.workdir, "gradlew"));
            const gradle = wrapper ? "./gradlew" : "gradle";
            if (wrapper || (await isAvailable("gradle -version", signal))) {
              const r = await run(`${gradle} compileJava -q --console=plain`, signal);
              if (r.code === 0) return `✓ ${rel} 校验通过（${v.label}，Gradle 项目编译）。`;
              return failed(r.output) + "\n（注：Gradle 项目级编译，错误可能来自其它文件）";
            }
          }

          // 回退：单文件 javac
          const single = await singleFileJavac();
          if (single !== null) return single;
          return skipped("可安装 JDK（javac），或在 Maven/Gradle 项目中提供 mvn/gradle 后重试。");
        }
      }
    },
    {
      name: "validate_file",
      description:
        "校验单个代码文件是否存在编译/语法错误。建议在 edit_file / write_file 修改代码文件后调用。" +
        "按扩展名自动选用校验器（TS 用 tsc、JS 用 node --check、Python/Ruby/Go/Shell/JSON 等）；" +
        "若用户环境未安装对应校验器会自动跳过（不报错）。只读、无副作用，无需授权。",
      schema,
    },
  );

  return { tool: validateFileTool, level: "read" };
}
