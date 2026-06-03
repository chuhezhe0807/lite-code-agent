/**
 * 沙箱命令执行器
 *
 * 这是「学习级」沙箱的核心：用 child_process.spawn 在锁定的工作目录（cwd）内执行命令，
 * 并施加两道约束：
 *   1. 超时：到点强制 SIGKILL 杀掉进程，防止卡死。
 *   2. 中断：支持外部传入 AbortSignal，被 abort 时立即杀进程（供 US-012 的 Esc 中断复用）。
 *
 * 注意：这里用 shell: true 以支持 "npm run build" 这类完整命令串，因此本身具有较高风险，
 * 必须配合授权层（US-007）使用。本模块只负责「执行并收集结果」，不做授权判断。
 */

import { spawn } from "node:child_process";

/** 执行选项 */
export interface ExecOptions {
  /** 工作目录（绝对路径），进程 cwd 锁定于此 */
  cwd: string;
  /** 超时时间（毫秒），到点杀进程 */
  timeoutMs: number;
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
  const { cwd, timeoutMs, signal } = options;
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

    const child = spawn(command, {
      cwd,
      shell: true,
      // 不继承 stdin，避免交互式命令挂起
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
