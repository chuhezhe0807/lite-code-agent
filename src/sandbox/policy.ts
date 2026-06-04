/**
 * 从应用配置构造沙箱策略（US-016）
 *
 * 默认可写白名单 = 工作目录 + 系统临时目录 + 常见包管理器缓存（~/.npm、~/.cache），
 * 否则 npm/pnpm/yarn install 会因无法写缓存而失败；再并入用户在 config.sandbox.writablePaths
 * 里额外指定的路径。网络与资源上限直接取自配置。
 */

import os from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../config.js";
import type { SandboxPolicy } from "./types.js";

/** 根据配置构造沙箱策略。 */
export function buildSandboxPolicy(config: AppConfig): SandboxPolicy {
  const home = os.homedir();
  const defaults = [
    config.workdir,
    os.tmpdir(),
    join(home, ".npm"), // npm 缓存
    join(home, ".cache"), // pnpm/yarn 等通用缓存
  ];
  // 去重并入用户额外指定的可写路径
  const writablePaths = [
    ...new Set([...defaults, ...config.sandbox.writablePaths]),
  ];

  return {
    cwd: config.workdir,
    writablePaths,
    allowNetwork: config.sandbox.allowNetwork,
    limits: config.sandbox.limits,
  };
}
