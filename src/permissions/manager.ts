/**
 * 授权管理器
 *
 * 把「规则存储 + 规则匹配 + 用户提问」组合成一个对外的 authorize() 决策入口。
 * agent 主循环（US-008）在实际执行每个工具前调用它，根据返回决定是否放行；
 * 被拒绝时把 reason 作为工具结果回传给 agent，使其能调整策略而非崩溃。
 *
 * 决策顺序：
 *   1. 只读工具（level=read）默认放行，不打扰用户。
 *   2. 命中 deny 规则 → 直接拒绝。
 *   3. 命中 allow 规则 → 免询问放行。
 *   4. 都不命中 → 询问用户（y/n/a/d）；选 a/d 时把本次调用泛化为规则，
 *      经用户确认后写回 settings.local.json。
 */

import type { ToolSpec } from "../tools/types.js";
import type { LocalSettings } from "./settings.js";
import { addRule } from "./settings.js";
import { matchesAny, generalizeRule } from "./match.js";
import type { AuthPrompter } from "./prompter.js";

/** 授权结果 */
export interface AuthResult {
  /** 是否放行 */
  allowed: boolean;
  /** 被拒绝时的原因，用于回传给 agent */
  reason?: string;
}

/** 授权管理器接口 */
export interface PermissionManager {
  authorize(
    spec: ToolSpec,
    args: Record<string, unknown>,
  ): Promise<AuthResult>;
}

/**
 * 从工具参数中提取「权限目标」字符串，用于规则匹配与泛化。
 * 约定：执行类工具看 command，文件类工具看 path，其余回退为 JSON。
 */
export function permissionTarget(args: Record<string, unknown>): string {
  if (typeof args.command === "string") return args.command;
  if (typeof args.path === "string") return args.path;
  return JSON.stringify(args);
}

/** 创建授权管理器所需依赖 */
export interface PermissionManagerDeps {
  /** .litecode 目录绝对路径 */
  litecodeDir: string;
  /** 已加载的本地设置（会被原地更新并持久化） */
  settings: LocalSettings;
  /** 用户提问者（readline 或 Ink 实现） */
  prompter: AuthPrompter;
}

/**
 * 创建授权管理器。
 */
export function createPermissionManager(
  deps: PermissionManagerDeps,
): PermissionManager {
  const { litecodeDir, settings, prompter } = deps;

  return {
    async authorize(spec, args): Promise<AuthResult> {
      const toolName = spec.tool.name;

      // 1. 只读工具默认放行
      if (spec.level === "read") return { allowed: true };

      const target = permissionTarget(args);

      // 2. deny 优先
      if (matchesAny(settings.permissions.deny, toolName, target)) {
        return { allowed: false, reason: "操作被 deny 规则拒绝。" };
      }

      // 3. allow 免询问
      if (matchesAny(settings.permissions.allow, toolName, target)) {
        return { allowed: true };
      }

      // 4. 询问用户
      const detail = (await spec.preview?.(args)) ?? `${toolName}(${target})`;
      const choice = await prompter.askDecision(detail);

      if (choice === "y") return { allowed: true };
      if (choice === "n") return { allowed: false, reason: "用户拒绝了本次操作。" };

      // a / d：泛化规则并请用户确认后写回
      const rule = generalizeRule(toolName, spec.level, target);
      const confirmed = await prompter.confirmRule(rule);
      if (choice === "a") {
        if (confirmed) addRule(litecodeDir, settings, "allow", rule);
        return { allowed: true };
      }
      // choice === "d"
      if (confirmed) addRule(litecodeDir, settings, "deny", rule);
      return { allowed: false, reason: "用户拒绝了该操作。" };
    },
  };
}
