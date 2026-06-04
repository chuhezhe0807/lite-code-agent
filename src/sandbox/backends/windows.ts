/**
 * Windows 后端（US-019，务实版）
 *
 * 现实约束：Windows 的强隔离能力（Job Object 资源限制、受限令牌、文件 ACL 沙箱）依赖 Win32
 * 原生 API，纯 Node 标准库无法在不引入原生模块的前提下创建 Job Object。因此本后端务实地：
 *   - wrapCommand 阶段不做隔离（Job Object 是 post-spawn API，无法在「包裹命令」时落地），
 *     行为等同 none 的 shell 执行（Windows 上即经由 cmd.exe）。
 *   - 真正有效的「整棵进程树终止」（taskkill /F /T）在 US-020 接入超时/中断的杀进程逻辑里实现，
 *     这也是 Windows 上最实际可得的进程组管控。
 *   - 文件越界主要依赖应用层的工作目录白名单兜底（见 src/security/path.ts），本后端不提供
 *     文件系统级隔离。
 *
 * 因此在 Windows 上应如实告知用户：原生隔离弱于 macOS/Linux，需要更强隔离请在 WSL2 中运行本工具
 * （可获得 Linux/bwrap 级隔离）。该告知由 detect.ts 的 advisory 在启动时打印。
 */

import type { SandboxBackend, SandboxCommand } from "../types.js";

/** 创建 Windows 后端（名义上的 jobobject）。 */
export function createWindowsBackend(): SandboxBackend {
  return {
    name: "jobobject",
    // Windows 上恒可用（cmd.exe 必然存在）；其「隔离」价值有限，仅作为进程组管控的挂载点
    isAvailable: () => process.platform === "win32",
    wrapCommand(command: string): SandboxCommand {
      // 无法在包裹阶段隔离：交给 shell 原样执行（等同 none）。进程树终止见 US-020。
      return { file: command, args: [], shell: true };
    },
  };
}
