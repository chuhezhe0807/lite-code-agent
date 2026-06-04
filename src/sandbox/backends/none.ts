/**
 * none 后端：不做任何隔离（US-016）
 *
 * 行为等同重构前的 runInSandbox：直接用 shell 执行原命令串，仅靠上层的 cwd 锁定、
 * 路径白名单（应用层）与超时来约束。它是各平台在缺少原生隔离机制时的降级目标，
 * 也是用户显式 sandbox.backend=none 时的选择。
 */

import type { SandboxBackend, SandboxCommand } from "../types.js";

/** 创建 none 后端（恒可用） */
export function createNoneBackend(): SandboxBackend {
  return {
    name: "none",
    isAvailable: () => true,
    wrapCommand(command: string): SandboxCommand {
      // 不包裹，交给 shell 原样执行
      return { file: command, args: [], shell: true };
    },
  };
}
