/**
 * 沙箱能力探测与后端选择（US-016）
 *
 * 启动时根据「配置 + 当前平台 + 已注册后端的可用性」选出实际生效的隔离后端，
 * 并产出人类可读的隔离等级与（如发生）降级原因，供启动概览打印和授权弹窗展示（US-021）。
 *
 * 设计原则：优雅降级——选定后端不可用时回退到 none 并给出明确原因，绝不抛错或阻断执行。
 * US-017~019 实现各平台后端后，只需在 REGISTRY 中登记，本文件的选择逻辑无需改动。
 */

import type { AppConfig } from "../config.js";
import type { SandboxBackend, SandboxBackendName } from "./types.js";
import { createNoneBackend } from "./backends/none.js";
import { createSeatbeltBackend } from "./backends/seatbelt.js";

/** 各平台「理想中最强」的后端。auto 模式据此挑选。 */
const STRONGEST_BY_PLATFORM: Record<string, SandboxBackendName> = {
  darwin: "seatbelt",
  linux: "bwrap",
  win32: "jobobject",
};

/**
 * 已实现并登记的后端工厂表。
 * 工厂返回后端实例，其 isAvailable() 负责判断当前机器是否真的能用。
 * 目前只有 none；US-017~019 会在此登记 seatbelt / bwrap / jobobject。
 */
const REGISTRY: Partial<Record<SandboxBackendName, () => SandboxBackend>> = {
  none: createNoneBackend,
  seatbelt: createSeatbeltBackend,
};

/** 每个后端对应的隔离等级说明（用于展示） */
const ISOLATION_DESC: Record<SandboxBackendName, string> = {
  none: "无隔离（命令以当前用户权限直接执行）",
  seatbelt: "macOS Seatbelt 文件/网络隔离",
  bwrap: "Linux bubblewrap namespace 隔离",
  landlock: "Linux Landlock LSM 隔离",
  jobobject: "Windows Job Object 进程组管控",
};

/** 后端选择结果 */
export interface SandboxSelection {
  /** 实际生效的后端 */
  backend: SandboxBackend;
  /** 本平台/配置「本应」使用的后端（未降级时与 backend.name 相同） */
  intended: SandboxBackendName;
  /** 是否发生了降级 */
  degraded: boolean;
  /** 降级原因（degraded 为 true 时给出） */
  reason?: string;
  /** 实际生效后端的隔离等级说明 */
  isolationLevel: string;
}

/** 解析一个后端名：已登记且当前可用则返回实例，否则返回不可用原因。 */
function resolve(
  name: SandboxBackendName,
): { backend: SandboxBackend } | { reason: string } {
  const factory = REGISTRY[name];
  if (!factory) {
    return { reason: `后端 ${name} 尚未启用（待后续 US 实现）` };
  }
  const backend = factory();
  if (!backend.isAvailable()) {
    return { reason: `后端 ${name} 在当前机器不可用（缺少依赖或平台不支持）` };
  }
  return { backend };
}

/**
 * 选择实际生效的沙箱后端。
 *
 * @param config 应用配置（读取 config.sandbox.backend）
 * @param platform 平台标识，默认 process.platform（便于测试注入）
 */
export function selectSandboxBackend(
  config: AppConfig,
  platform: NodeJS.Platform = process.platform,
): SandboxSelection {
  const choice = config.sandbox.backend;
  const none = createNoneBackend();

  // 显式 none：直接不隔离，不算降级
  if (choice === "none") {
    return {
      backend: none,
      intended: "none",
      degraded: false,
      isolationLevel: ISOLATION_DESC.none,
    };
  }

  // 确定「本应使用」的后端：auto → 按平台挑最强；否则用指定名
  const intended: SandboxBackendName =
    choice === "auto" ? (STRONGEST_BY_PLATFORM[platform] ?? "none") : choice;

  // 目标就是 none（如冷门平台 auto 落到 none）
  if (intended === "none") {
    return {
      backend: none,
      intended: "none",
      degraded: false,
      isolationLevel: ISOLATION_DESC.none,
    };
  }

  const resolved = resolve(intended);
  if ("backend" in resolved) {
    return {
      backend: resolved.backend,
      intended,
      degraded: false,
      isolationLevel: ISOLATION_DESC[intended],
    };
  }

  // 降级到 none，并说明原因
  const prefix = choice === "auto" ? "自动选择的" : "指定的";
  return {
    backend: none,
    intended,
    degraded: true,
    reason: `${prefix}${resolved.reason}，已降级为 none（无隔离）`,
    isolationLevel: ISOLATION_DESC.none,
  };
}
