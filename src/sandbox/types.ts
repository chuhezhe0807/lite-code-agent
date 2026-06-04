/**
 * 沙箱抽象层的核心类型（US-016）
 *
 * 目的：把「如何把一条命令包裹进隔离环境」从「怎么执行（超时/中断/收集输出）」中拆出来，
 * 让上层 run_command 不关心 OS 差异，并能在缺少原生隔离机制时安全降级。
 *
 * 本文件是「纯类型」模块，不依赖 config / node 运行时，避免与 config 形成循环依赖。
 * 各平台的具体后端（macOS Seatbelt / Linux bubblewrap / Windows Job Object）在 US-017~019 实现，
 * 它们都实现这里的 SandboxBackend 接口。
 */

/** 已实现/规划中的隔离后端名称（不含配置层的 "auto"） */
export type SandboxBackendName =
  | "none" // 不隔离：命令以当前用户权限直接执行（现状行为，也是各平台的降级目标）
  | "seatbelt" // macOS：sandbox-exec（US-017）
  | "bwrap" // Linux：bubblewrap（US-018）
  | "landlock" // Linux：Landlock LSM（US-018 可选增强）
  | "jobobject"; // Windows：Job Object（US-019）

/** 资源上限（US-020 落地具体执行；这里先把策略字段定义出来） */
export interface ResourceLimits {
  /** 最大子进程数（防 fork 炸弹） */
  maxProcesses?: number;
  /** 最大虚拟内存字节数 */
  maxMemoryBytes?: number;
  /** 最大 CPU 时间（秒） */
  cpuTimeSeconds?: number;
}

/**
 * 沙箱策略：描述「这条命令被允许做什么」。
 * 由 buildSandboxPolicy(config) 从应用配置构造，再交给选定后端去落实。
 */
export interface SandboxPolicy {
  /** 工作目录（绝对路径），进程 cwd 锁定于此 */
  cwd: string;
  /** 可写路径白名单（绝对路径），默认含 cwd + 系统 tmp + 包管理器缓存 */
  writablePaths: string[];
  /** 是否允许访问网络（默认 true，因为 npm install 等通常需要联网） */
  allowNetwork: boolean;
  /** 资源上限 */
  limits: ResourceLimits;
}

/**
 * 后端把一条 shell 命令「包裹」后得到的可执行规格，直接交给 child_process.spawn。
 * - none 后端：{ file: command, args: [], shell: true }，等同直接用 shell 跑原命令。
 * - seatbelt：{ file: "sandbox-exec", args: ["-p", profile, "/bin/sh", "-c", command], shell: false }。
 */
export interface SandboxCommand {
  /** 要 spawn 的可执行文件（或在 shell=true 时的完整命令串） */
  file: string;
  /** 传给可执行文件的参数 */
  args: string[];
  /** 是否以 shell 模式 spawn（none 后端为 true，包裹型后端为 false） */
  shell: boolean;
}

/** 隔离后端接口：各平台实现各自的 wrapCommand */
export interface SandboxBackend {
  /** 后端名称 */
  readonly name: SandboxBackendName;
  /** 当前机器是否可用（如所需二进制存在、平台匹配）。none 恒为 true。 */
  isAvailable(): boolean;
  /**
   * 把一条 shell 命令包裹进隔离环境，返回可交给 spawn 的规格。
   * @param command 完整命令串
   * @param policy 沙箱策略
   */
  wrapCommand(command: string, policy: SandboxPolicy): SandboxCommand;
}
