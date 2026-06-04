/**
 * macOS Seatbelt 后端（US-017）
 *
 * 用 macOS 自带的 sandbox-exec 把命令包裹进 Seatbelt 沙箱：
 *   sandbox-exec -p <SBPL profile> /bin/sh -c <command>
 *
 * Profile 以 (deny default) 起步，再按 SandboxPolicy 精确放行：
 *   - 进程：允许 process-exec / process-fork（否则连 /bin/sh、node 都起不来）；
 *   - 读：file-read* 全放行（隔离重点在「写」，读放开以免动态库/解释器加载失败）；
 *   - 写：file-write* 仅限可写白名单 + 必要的设备节点（/dev/null、tty 等）；
 *   - 网络：allowNetwork=false 时不放行 network*，从而切断网络。
 *
 * 注意：sandbox-exec 被 Apple 标为 deprecated，但至今仍可用（Claude Code、Codex CLI 等都在用）。
 * 若系统上不存在该二进制，isAvailable() 返回 false，由 detect.ts 优雅降级为 none。
 */

import { existsSync, realpathSync } from "node:fs";
import type {
  SandboxBackend,
  SandboxCommand,
  SandboxPolicy,
} from "../types.js";

/** sandbox-exec 的固定路径（macOS 系统自带） */
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** 把路径转成 SBPL 字符串字面量（双引号包裹并转义反斜杠与双引号），兼容含空格的路径。 */
function sbplString(p: string): string {
  return `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * 规范化可写路径：尽量取 realpath（Seatbelt 按真实路径匹配，
 * 例如 /var/folders/... 实为 /private/var/folders/...，/tmp 实为 /private/tmp）。
 * 路径不存在时退回原值。返回去重后的列表。
 */
function canonicalize(paths: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    try {
      out.add(realpathSync(p));
    } catch {
      out.add(p);
    }
  }
  return [...out];
}

/** 生成 SBPL profile 文本。 */
function buildProfile(policy: SandboxPolicy): string {
  const writable = canonicalize(policy.writablePaths);
  const lines: string[] = [
    "(version 1)",
    "(deny default)",
    // 进程：允许执行与派生子进程
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow signal (target self))",
    // 系统信息读取与服务查找：很多命令、动态库加载、解释器启动都依赖
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    // 读：全放行（隔离重点在写）
    "(allow file-read*)",
    // 写：仅限可写白名单 + 必要设备节点
    "(allow file-write*",
    ...writable.map((p) => `  (subpath ${sbplString(p)})`),
    '  (literal "/dev/null")',
    '  (literal "/dev/zero")',
    '  (literal "/dev/stdout")',
    '  (literal "/dev/stderr")',
    '  (regex #"^/dev/tty")',
    ")",
  ];

  // 网络：仅在允许时放行；不写则被 (deny default) 切断
  if (policy.allowNetwork) {
    lines.push("(allow network*)");
  }

  return lines.join("\n");
}

/** 创建 macOS Seatbelt 后端。 */
export function createSeatbeltBackend(): SandboxBackend {
  return {
    name: "seatbelt",
    isAvailable: () =>
      process.platform === "darwin" && existsSync(SANDBOX_EXEC),
    wrapCommand(command: string, policy: SandboxPolicy): SandboxCommand {
      const profile = buildProfile(policy);
      // shell:false——profile 作为单个 argv 传入，无需 shell 转义；命令本身仍交给 /bin/sh 解释
      return {
        file: SANDBOX_EXEC,
        args: ["-p", profile, "/bin/sh", "-c", command],
        shell: false,
      };
    },
  };
}
