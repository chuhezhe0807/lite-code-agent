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

/**
 * 默认环境变量白名单（US-020）：只透传命令运行所必需的基础变量，
 * 其余（含 ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / LANGFUSE_* / LLM_* 等密钥）一律不传给子进程。
 * 包含 Windows 下 cmd.exe 正常工作所需的 SystemRoot / ComSpec / PATHEXT / WINDIR 等。
 */
const DEFAULT_ENV_ALLOWLIST = [
  // 通用
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TZ",
  "TMPDIR",
  "TEMP",
  "TMP",
  // 代理（联网命令常需要）
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  // Windows
  "USERPROFILE",
  "SystemRoot",
  "SystemDrive",
  "ComSpec",
  "PATHEXT",
  "WINDIR",
  "NUMBER_OF_PROCESSORS",
];

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

  // 环境变量白名单：默认 + 用户额外透传，去重
  const envAllowlist = [
    ...new Set([...DEFAULT_ENV_ALLOWLIST, ...config.sandbox.envPassthrough]),
  ];

  return {
    cwd: config.workdir,
    writablePaths,
    allowNetwork: config.sandbox.allowNetwork,
    limits: config.sandbox.limits,
    envAllowlist,
  };
}
