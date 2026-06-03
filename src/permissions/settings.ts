/**
 * 本地授权设置（.litecode/settings.local.json）的读写
 *
 * 结构对齐 Claude Code：
 *   {
 *     "permissions": {
 *       "allow": ["read_file(*)", "run_command(npx tsc *)"],
 *       "deny":  ["run_command(rm -rf *)"]
 *     }
 *   }
 *
 * 规则格式为 `工具名(参数模式)`，参数模式支持 `*` 通配（见 match.ts）。
 * 用户在授权交互中选择「始终允许/拒绝」时，泛化出的规则会被追加到对应列表并持久化，
 * 下次会话启动时自动加载，从而做到「记住选择」跨会话生效。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 权限规则集合 */
export interface Permissions {
  allow: string[];
  deny: string[];
}

/** settings.local.json 的整体结构 */
export interface LocalSettings {
  permissions: Permissions;
}

/** 默认设置（空规则） */
function defaultSettings(): LocalSettings {
  return { permissions: { allow: [], deny: [] } };
}

/** settings 文件在 .litecode 目录下的文件名 */
const SETTINGS_FILE = "settings.local.json";

/** 计算 settings 文件的绝对路径 */
export function settingsPath(litecodeDir: string): string {
  return join(litecodeDir, SETTINGS_FILE);
}

/**
 * 加载本地设置。文件不存在时创建默认文件并返回默认值。
 * 解析失败时回退到默认值（不抛出，避免坏文件阻塞启动）。
 *
 * @param litecodeDir .litecode 目录绝对路径
 */
export function loadSettings(litecodeDir: string): LocalSettings {
  const path = settingsPath(litecodeDir);
  if (!existsSync(path)) {
    const def = defaultSettings();
    writeFileSync(path, JSON.stringify(def, null, 2), "utf-8");
    return def;
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<LocalSettings>;
    return {
      permissions: {
        allow: raw.permissions?.allow ?? [],
        deny: raw.permissions?.deny ?? [],
      },
    };
  } catch {
    return defaultSettings();
  }
}

/**
 * 保存本地设置到磁盘。
 * @param litecodeDir .litecode 目录绝对路径
 * @param settings 要写入的设置
 */
export function saveSettings(litecodeDir: string, settings: LocalSettings): void {
  writeFileSync(
    settingsPath(litecodeDir),
    JSON.stringify(settings, null, 2),
    "utf-8",
  );
}

/**
 * 向 allow 或 deny 列表追加一条规则并立即持久化（去重）。
 *
 * @param litecodeDir .litecode 目录绝对路径
 * @param settings 当前设置（会被原地更新）
 * @param list 追加到哪个列表
 * @param rule 规则字符串，如 "run_command(npx tsc *)"
 */
export function addRule(
  litecodeDir: string,
  settings: LocalSettings,
  list: "allow" | "deny",
  rule: string,
): void {
  const target = settings.permissions[list];
  if (!target.includes(rule)) {
    target.push(rule);
    saveSettings(litecodeDir, settings);
  }
}
