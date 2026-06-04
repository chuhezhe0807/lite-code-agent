/**
 * 沙箱命令执行器
 *
 * 职责单一：用 child_process.spawn「执行并收集结果」，并施加约束：
 *   1. 超时：到点强制杀掉**整棵进程树**，防止卡死。
 *   2. 中断：支持外部传入 AbortSignal，被 abort 时立即杀整棵进程树（供 US-012 的 Esc 中断复用）。
 *
 * 「如何把命令包裹进隔离环境」由传入的 SandboxBackend 决定（US-016）。在此之上，本模块做一组
 * 与后端无关的通用加固（US-020）：
 *   - 整棵进程树终止：POSIX 用 detached 进程组 + 杀负 pid；Windows 用 taskkill /T，
 *     避免「只杀了 shell，npm→node 等子进程残留」。
 *   - 环境变量清洗：只把 policy.envAllowlist 命中的变量传给子进程，避免泄漏 API Key 等密钥。
 *   - 资源限制：POSIX 下按 policy.limits 注入 ulimit 前缀（进程数/内存/CPU 时间）。
 * 本模块不做授权判断，须配合授权层（US-007）。
 */

// spawn 用于在沙箱中执行命令，支持超时和外部中断，流式创建子进程，适合长时间、大输出的命令（npm run、shell脚本等）
// 数据分段返回，不缓存全部输出到内存
import { spawn, type ChildProcess } from "node:child_process";
import type { ResourceLimits, SandboxBackend, SandboxPolicy } from "./types.js";

const isWindows = process.platform === "win32";

/**
 * 杀掉子进程**整棵树**。
 * - POSIX：子进程以 detached 方式启动后是「进程组组长」，向负 pid 发信号即可杀掉整组
 *   （shell 及其 fork 出来的 npm/node 等全部命中）。
 * - Windows：用 taskkill /T 递归杀掉子树（/F 强制）。
 */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (isWindows) {
    // 异步杀树，忽略其自身输出与错误
    spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL"); // 负号=杀整个进程组
  } catch {
    // 兜底：进程组不存在时直接杀子进程本身
    try {
      child.kill("SIGKILL");
    } catch {
      /* 进程可能已退出，忽略 */
    }
  }
}

/** 构造传给子进程的环境变量：仅透传白名单命中的变量，其余（含密钥）一律丢弃。 */
function buildEnv(allowlist: string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of allowlist) {
    const v = process.env[name];
    if (v !== undefined) env[name] = v;
  }
  return env;
}

/**
 * 构造 POSIX 资源限制前缀（ulimit）。各项独立成句并吞掉错误（`2>/dev/null`），
 * 这样某项在当前平台不被支持（如 macOS 的 `ulimit -v`）也不会中断命令。
 * 注意：`ulimit -u` 是 per-user 语义（限制整个用户的进程数，非仅本子树）。
 */
function buildUlimitPrefix(limits: ResourceLimits): string {
  const parts: string[] = [];
  if (limits.maxProcesses != null) {
    parts.push(`ulimit -u ${limits.maxProcesses} 2>/dev/null`);
  }
  if (limits.cpuTimeSeconds != null) {
    parts.push(`ulimit -t ${limits.cpuTimeSeconds} 2>/dev/null`);
  }
  if (limits.maxMemoryBytes != null) {
    // ulimit -v 单位为 KB
    parts.push(`ulimit -v ${Math.ceil(limits.maxMemoryBytes / 1024)} 2>/dev/null`);
  }
  return parts.length > 0 ? parts.join("; ") + "; " : "";
}

/** 执行选项 */
export interface ExecOptions {
  /** 工作目录（绝对路径），进程 cwd 锁定于此 */
  cwd: string;
  /** 超时时间（毫秒），到点杀进程 */
  timeoutMs: number;
  /** 隔离后端：决定命令如何被包裹进沙箱 */
  backend: SandboxBackend;
  /** 沙箱策略：可写路径、网络、资源上限等 */
  policy: SandboxPolicy;
  /** 可选的外部中断信号；被 abort 时杀进程 */
  signal?: AbortSignal;
  /** stdout/stderr 各自在内存中累积的字节上限（防止超大输出撑爆内存），默认取 2×预算 */
  maxAccumulateBytes?: number;
}

/** 执行结果 */
export interface ExecResult {
  /** 标准输出（可能已因内存上限被截断） */
  stdout: string;
  /** 标准错误（可能已因内存上限被截断） */
  stderr: string;
  /** 退出码；被信号杀死时为 null */
  code: number | null;
  /** 终止信号（如 SIGKILL）；正常退出时为 null */
  signalName: NodeJS.Signals | null;
  /** 是否因超时被杀 */
  timedOut: boolean;
  /** 是否因外部中断被杀 */
  aborted: boolean;
  /** spawn 自身错误（如命令不存在）的消息，正常时为 undefined */
  spawnError?: string;
}

/**
 * 在沙箱中执行一条命令。
 *
 * @param command 完整命令串（经 shell 执行）
 * @param options 执行选项
 * @returns 执行结果（永不 reject，错误以结果字段表达，便于上层统一处理）
 */
export function runInSandbox(
  command: string,
  options: ExecOptions,
): Promise<ExecResult> {
  const { cwd, timeoutMs, signal, backend, policy } = options;
  const cap = options.maxAccumulateBytes ?? 0; // 0 表示不额外限制累积

  return new Promise<ExecResult>((resolve) => {
    // 若传入的 signal 已经处于 abort 状态，直接返回中断结果，不启动进程
    if (signal?.aborted) {
      resolve({
        stdout: "",
        stderr: "",
        code: null,
        signalName: null,
        timedOut: false,
        aborted: true,
      });
      return;
    }

    // POSIX 下按资源上限注入 ulimit 前缀（命令经 shell 执行，故可前置）；Windows 暂不支持
    const effectiveCommand = isWindows
      ? command
      : buildUlimitPrefix(policy.limits) + command;

    // 由后端把命令包裹成 spawn 规格（none 后端等同 shell 直接跑原命令）
    const spec = backend.wrapCommand(effectiveCommand, policy);
    const child = spawn(spec.file, spec.args, {
      cwd,
      shell: spec.shell,
      // 不继承 stdin，避免交互式命令挂起，其实就是关闭子进程输入，防止命令等待交互卡住
      // stdio 的三个值分别是：[stdin, stdout, stderr] 标准输入/标准输出/标准错误
      stdio: ["ignore", "pipe", "pipe"],
      // POSIX：独立进程组，便于一次杀掉整棵进程树（见 killTree）
      detached: !isWindows,
      // 环境变量清洗：只透传白名单变量，避免把 API Key 等密钥泄漏给被执行命令
      env: buildEnv(policy.envAllowlist),
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;

    // 累积输出，带可选的内存上限保护
    const append = (buf: string, chunk: Buffer): string => {
      if (cap > 0 && buf.length >= cap) return buf;
      return buf + chunk.toString("utf-8");
    };
    child.stdout.on("data", (c: Buffer) => {
      stdout = append(stdout, c);
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr = append(stderr, c);
    });

    // 超时：到点强制杀掉整棵进程树
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    // 外部中断：被 abort 时杀掉整棵进程树
    const onAbort = () => {
      aborted = true;
      killTree(child);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    // spawn 自身错误（如命令不存在 / cwd 不存在）
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        stdout,
        stderr,
        code: null,
        signalName: null,
        timedOut,
        aborted,
        spawnError: err.message,
      });
    });

    // 进程结束
    child.on("close", (code, sig) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        stdout,
        stderr,
        code,
        signalName: sig,
        timedOut,
        aborted,
      });
    });
  });
}
