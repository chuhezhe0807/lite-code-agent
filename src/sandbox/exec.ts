/**
 * 沙箱命令执行器
 *
 * 职责单一：用 child_process.spawn「执行并收集结果」，并施加两道约束：
 *   1. 超时：到点强制 SIGKILL 杀掉进程，防止卡死。
 *   2. 中断：支持外部传入 AbortSignal，被 abort 时立即杀进程（供 US-012 的 Esc 中断复用）。
 *
 * 「如何把命令包裹进隔离环境」由传入的 SandboxBackend 决定（US-016）：本模块先用
 * backend.wrapCommand 把命令转成 spawn 规格，再统一执行。none 后端等同直接用 shell 跑原命令，
 * seatbelt / bwrap 等后端则会包裹一层隔离器。本模块不做授权判断，须配合授权层（US-007）。
 */

// spawn 用于在沙箱中执行命令，支持超时和外部中断，流式创建子进程，适合长时间、大输出的命令（npm run、shell脚本等）
// 数据分段返回，不缓存全部输出到内存
import { spawn } from "node:child_process";
import type { SandboxBackend, SandboxPolicy } from "./types.js";

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

    // 由后端把命令包裹成 spawn 规格（none 后端等同 shell 直接跑原命令）
    const spec = backend.wrapCommand(command, policy);
    const child = spawn(spec.file, spec.args, {
      cwd,
      shell: spec.shell,
      // 不继承 stdin，避免交互式命令挂起，其实就是关闭子进程输入，防止命令等待交互卡住
      // stdio 的三个值分别是：[stdin, stdout, stderr] 标准输入/标准输出/标准错误
      stdio: ["ignore", "pipe", "pipe"],
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

    // 超时：到点强制杀进程
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    // 外部中断：被 abort 时杀进程
    const onAbort = () => {
      aborted = true;
      child.kill("SIGKILL");
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
