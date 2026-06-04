/**
 * run_command 工具：在受限沙箱中执行命令或项目构建脚本（属「执行」级别，最高风险，需授权）。
 *
 * 设计要点：
 *   - 委托 src/sandbox/exec.ts 执行：cwd 锁定工作目录、超时杀进程、支持 AbortSignal。
 *   - 从 LangChain 的 RunnableConfig 透传 signal，使 US-012 的 Esc 中断可以杀掉子进程。
 *   - 输出按字节预算做「头 + 尾」截断，始终完整返回退出码。
 *   - preview() 展示完整命令，供授权层确认。
 */

import { z } from "zod";
import { tool } from "@langchain/core/tools";
import type { AppConfig } from "../config.js";
import { runInSandbox } from "../sandbox/exec.js";
import { buildSandboxPolicy } from "../sandbox/policy.js";
import type { ResourceLimits, SandboxBackend } from "../sandbox/types.js";
import { truncateHeadTail } from "../util/truncate.js";
import type { ToolSpec } from "./types.js";

/** 把资源上限格式化成人类可读串，全空时显示「未限制」。 */
function formatLimits(limits: ResourceLimits): string {
  const parts: string[] = [];
  if (limits.maxProcesses != null) parts.push(`进程 ${limits.maxProcesses}`);
  if (limits.cpuTimeSeconds != null) parts.push(`CPU ${limits.cpuTimeSeconds}s`);
  if (limits.maxMemoryBytes != null) {
    parts.push(`内存 ${Math.round(limits.maxMemoryBytes / 1024 / 1024)}MB`);
  }
  return parts.length > 0 ? parts.join(" / ") : "未限制（仅超时）";
}

const schema = z.object({
  command: z
    .string()
    .describe("要执行的完整 shell 命令，例如 'npm test' 或 'npx tsc --noEmit'"),
});

/**
 * 创建 run_command 工具。
 * @param config 应用配置（提供 workdir、超时、输出预算）
 * @param backend 选定的沙箱后端（US-016，由启动时能力探测得出）
 */
export function createRunCommandTool(
  config: AppConfig,
  backend: SandboxBackend,
): ToolSpec {
  // 策略只依赖配置，构建一次即可复用
  const policy = buildSandboxPolicy(config);

  const runCommandTool = tool(
    // 第二个参数是 RunnableConfig，可携带 AbortSignal（US-012 透传）
    async (input, runnableConfig): Promise<string> => {
      const { command } = input;
      const signal = runnableConfig?.signal;

      const result = await runInSandbox(command, {
        cwd: config.workdir,
        timeoutMs: config.commandTimeoutMs,
        backend,
        policy,
        signal,
        // 内存累积上限给到预算的 4 倍，避免超大输出撑爆内存
        maxAccumulateBytes: config.commandOutputMaxBytes * 4,
      });

      // spawn 自身错误（命令不存在等）
      if (result.spawnError) {
        return `错误：命令无法执行：${result.spawnError}`;
      }

      // 组装结果：状态行 + 截断后的 stdout/stderr
      const lines: string[] = [];
      if (result.aborted) {
        lines.push("命令被用户中断（已杀进程）。");
      } else if (result.timedOut) {
        lines.push(
          `命令超时（超过 ${config.commandTimeoutMs}ms），已被强制终止。`,
        );
      }
      lines.push(
        `退出码: ${result.code ?? `null（被信号 ${result.signalName} 终止）`}`,
      );

      const budget = { maxBytes: config.commandOutputMaxBytes };
      const stdout = truncateHeadTail(result.stdout, budget);
      const stderr = truncateHeadTail(result.stderr, budget);
      lines.push(`--- stdout ---\n${stdout || "(空)"}`);
      lines.push(`--- stderr ---\n${stderr || "(空)"}`);

      return lines.join("\n");
    },
    {
      name: "run_command",
      description:
        "在工作目录内执行 shell 命令或构建/测试脚本（如 npm test、tsc）。需要用户授权。带超时保护。",
      schema,
    },
  );

  /**
   * 授权前预览（US-021）：除完整命令外，附带沙箱作用域摘要，让用户在批准前看清
   * 「命令能改动什么」。展示的可写白名单 / 网络 / 资源上限均取自同一个 policy 对象，
   * 与实际传给后端的策略完全一致，不会误导。
   */
  const preview: ToolSpec["preview"] = (args) => {
    const lines: string[] = [];
    lines.push(`【执行命令】${String(args.command ?? "")}`);
    lines.push(`工作目录：${config.workdir}`);
    lines.push(`沙箱后端：${backend.name}`);
    lines.push(`可写路径：${policy.writablePaths.join("  ") || "(无)"}`);
    lines.push(`网络：${policy.allowNetwork ? "允许" : "已切断"}`);
    lines.push(`资源上限：${formatLimits(policy.limits)}`);
    lines.push(`超时：${config.commandTimeoutMs}ms`);
    // 降级到 none 时强提示：无任何 OS 级隔离
    if (backend.name === "none") {
      lines.push(
        "⚠ 无沙箱隔离：命令将以当前用户权限直接运行，仅受工作目录白名单与超时约束。",
      );
    }
    return lines.join("\n");
  };

  return { tool: runCommandTool, level: "execute", preview };
}
