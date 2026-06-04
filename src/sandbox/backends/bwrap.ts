/**
 * Linux bubblewrap 后端（US-018）
 *
 * 用 bubblewrap（bwrap）把命令放进一个新的 mount/pid namespace 执行：
 *   bwrap <隔离参数...> /bin/sh -c <command>
 *
 * 隔离策略（与 Seatbelt 后端保持一致的语义）：
 *   - 文件读：把宿主根目录以**只读**方式绑定进沙箱（--ro-bind / /），从而能读 /usr、/bin、
 *     /lib、解释器与依赖；隔离重点在「写」。
 *   - 文件写：仅对可写白名单里**实际存在**的路径做可写绑定（--bind），其余保持只读。
 *   - 网络：allowNetwork=false 时 --unshare-net 切断网络；为 true 时共享宿主网络。
 *   - 进程：--unshare-pid 独立 PID 命名空间，--die-with-parent 父进程退出即清理，
 *     --new-session 防止 TIOCSTI 终端注入。
 *
 * bwrap 未安装时 isAvailable() 返回 false，由 detect.ts 优雅降级为 none，并提示安装方式。
 * 说明：Landlock LSM 后端是 AC 中的可选增强，纯 Node 不便直接调用其系统调用，本版本未实现。
 */

import { existsSync } from "node:fs";
import { join, delimiter, isAbsolute } from "node:path";
import type {
  SandboxBackend,
  SandboxCommand,
  SandboxPolicy,
} from "../types.js";

/** 在 PATH 中查找可执行文件，返回绝对路径；找不到返回 null。 */
function findExecutable(name: string): string | null {
  if (isAbsolute(name)) return existsSync(name) ? name : null;
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    const full = join(dir, name);
    if (existsSync(full)) return full;
  }
  return null;
}

/** 生成 bwrap 参数（不含 bwrap 自身与最终命令），便于单测。 */
export function buildBwrapArgs(policy: SandboxPolicy): string[] {
  const args: string[] = [
    // 宿主根目录只读绑定：可读 /usr /bin /lib 等，但默认不可写
    "--ro-bind",
    "/",
    "/",
    // 独立的 /proc 与 /dev
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    // 进程隔离与清理
    "--unshare-pid",
    "--die-with-parent",
    "--new-session",
  ];

  // 网络：不允许时切断
  if (!policy.allowNetwork) {
    args.push("--unshare-net");
  }

  // 可写白名单：仅绑定实际存在的路径（bwrap 绑定不存在的路径会报错）
  for (const p of policy.writablePaths) {
    if (existsSync(p)) {
      args.push("--bind", p, p);
    }
  }

  // 进入工作目录
  args.push("--chdir", policy.cwd);

  return args;
}

/** 创建 Linux bubblewrap 后端。 */
export function createBwrapBackend(): SandboxBackend {
  return {
    name: "bwrap",
    isAvailable: () =>
      process.platform === "linux" && findExecutable("bwrap") !== null,
    wrapCommand(command: string, policy: SandboxPolicy): SandboxCommand {
      const bwrap = findExecutable("bwrap") ?? "bwrap";
      return {
        file: bwrap,
        args: [...buildBwrapArgs(policy), "/bin/sh", "-c", command],
        shell: false,
      };
    },
  };
}
