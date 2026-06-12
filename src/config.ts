/**
 * 配置加载模块
 *
 * 职责：把「命令行运行时所需的所有配置」从环境变量 / .env 文件合并成一个强类型对象。
 *
 * 单一来源：所有配置只来自环境变量（启动时由 dotenv 从 .env 载入），缺失则回落到内置默认值。
 * 见 .env.example 获取完整变量清单。结构化字段（如沙箱白名单）用逗号分隔的列表表达。
 */

import { existsSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import dotenv from "dotenv";
import type { ResourceLimits, SandboxBackendName } from "./sandbox/types.js";

// 启动时加载 .env 文件（若存在），把其中的键值写入 process.env
dotenv.config();

/** 支持的 LLM provider 类型。初版只实现 anthropic，其余为后续扩展预留。 */
export type ProviderType = "anthropic" | "openai" | "ollama";

/** LLM provider 相关配置 */
export interface ProviderConfig {
  /** provider 类型，默认 anthropic */
  type: ProviderType;
  /** API 密钥（以 x-api-key 头发送，对应 ANTHROPIC_API_KEY） */
  apiKey: string;
  /**
   * Auth Token（以 Authorization: Bearer 头发送，对应 ANTHROPIC_AUTH_TOKEN）。
   * 很多第三方代理 / 网关（如 LiteLLM）用 Bearer 方式鉴权，Claude Code 也用这个变量。
   * 与 apiKey 二选一即可；同时存在时优先用 authToken（Bearer）。
   */
  authToken?: string;
  /** 自定义 API base url，可选，用于代理或兼容网关 */
  baseURL?: string;
  /** 模型名称，默认 claude-sonnet-4-6 */
  model: string;
}

/** Langfuse 监控配置（全部可选；缺失则自动关闭监控） */
export interface LangfuseConfig {
  publicKey?: string;
  secretKey?: string;
  baseURL?: string;
}

/** 沙箱后端选择：auto 按平台自动选最强，none 显式关闭隔离，其余为指定后端 */
export type SandboxBackendChoice = "auto" | SandboxBackendName;

/** 沙箱配置（US-016） */
export interface SandboxConfig {
  /** 后端选择，默认 auto */
  backend: SandboxBackendChoice;
  /** 是否允许命令访问网络，默认 true（npm install 等通常需要联网） */
  allowNetwork: boolean;
  /** 在默认可写白名单（cwd + tmp + 包管理器缓存）之外额外允许写入的绝对路径 */
  writablePaths: string[];
  /** 资源上限（US-020）：进程数/内存/CPU 时间，缺省不限制 */
  limits: ResourceLimits;
  /** 在默认环境变量白名单之外额外透传给被执行命令的变量名（US-020） */
  envPassthrough: string[];
}

/** Agent 运行时整体配置 */
export interface AppConfig {
  /** LLM provider 配置 */
  provider: ProviderConfig;
  /** Agent 可操作的工作目录（绝对路径），所有文件/命令操作被限制在此目录内 */
  workdir: string;
  /** 命令执行超时时间（毫秒），默认 30000 */
  commandTimeoutMs: number;
  /** read_file 默认最多读取的行数，默认 2000 */
  readFileMaxLines: number;
  /** run_command 输出的字节预算，默认 30KB */
  commandOutputMaxBytes: number;
  /**
   * Agent 主循环单轮提交内的「绝对轮数上限」（agent 节点执行次数），默认 100。
   * 仅作防御性硬兜底，正常长任务通常不会触达；真正的死循环由 maxRepeatedActions 提前拦截。
   */
  maxIterations: number;
  /**
   * 死循环检测阈值，默认 4：当 agent「连续重复同一动作（tool_calls 的 name+args 签名）」
   * 达到该次数时判定为死循环并停止。签名一旦变化即清零，故正常推进的任务不受影响。
   */
  maxRepeatedActions: number;
  /**
   * 是否启用 Anthropic prompt caching（US-015，默认 false）。
   * 启用时给系统提示加 cache_control，缓存「tools + system」稳定前缀以省输入 token；
   * 需 LLM 端点（官方或兼容网关）支持 cache_control，否则被忽略、不报错。
   */
  promptCaching: boolean;
  /**
   * 历史中单条工具结果在「重发给模型」时的字节上限（US-015，默认 8192，0=不压缩）。
   * 超过则头尾截断，避免多轮对话每轮重发大块旧工具输出（输入 token 大头）。
   * 仅影响后续轮的重发，不影响该结果产生当轮的完整可见。
   */
  historyToolResultMaxBytes: number;
  /**
   * 触发对话历史自动压缩的字节阈值（US-024，默认 60KB，0=关闭）。
   * 当跨轮累积 history 的估算字节数超过该值时，提交前用 LLM 摘要较旧历史、保留最近若干轮，
   * 避免长会话历史无限增长撑爆 context window。
   */
  historyCompactionMaxBytes: number;
  /** 沙箱配置（US-016） */
  sandbox: SandboxConfig;
  /** Langfuse 监控配置（可选） */
  langfuse?: LangfuseConfig;
}

/** 内置默认值 */
const DEFAULTS = {
  providerType: "anthropic" as ProviderType,
  model: "claude-sonnet-4-6",
  commandTimeoutMs: 30_000,
  readFileMaxLines: 2000,
  commandOutputMaxBytes: 30 * 1024,
  maxIterations: 100,
  maxRepeatedActions: 4,
  promptCaching: false,
  historyToolResultMaxBytes: 8192,
  historyCompactionMaxBytes: 60 * 1024,
  sandboxBackend: "auto" as SandboxBackendChoice,
  sandboxAllowNetwork: true,
};

/**
 * 加载并校验完整配置（单一来源：环境变量 / .env，缺失回落到默认值）。
 *
 * @param cwd 进程当前工作目录，默认 process.cwd()
 * @returns 强类型配置对象
 * @throws 当缺少必需的 apiKey/authToken 时抛出明确错误
 */
export function loadConfig(cwd: string = process.cwd()): AppConfig {
  const env = process.env;

  const providerType = (env.PROVIDER_TYPE ??
    DEFAULTS.providerType) as ProviderType;

  // apiKey / authToken / baseURL / model：兼容 ANTHROPIC_* 与通用 LLM_* 两套变量名
  const apiKey = env.ANTHROPIC_API_KEY ?? env.LLM_API_KEY ?? "";
  // authToken：Bearer 鉴权，常用于代理/网关（Claude Code 用 ANTHROPIC_AUTH_TOKEN）
  const authToken = env.ANTHROPIC_LLM_AUTH_TOKEN ?? env.LLM_AUTH_TOKEN;
  const baseURL = env.ANTHROPIC_BASE_URL ?? env.LLM_BASE_URL;
  const model = env.LLM_MODEL ?? DEFAULTS.model;

  // 工作目录：环境变量 > 当前目录；统一转为绝对路径
  const workdir = resolve(env.WORKDIR ?? cwd);

  // 沙箱配置：结构化字段用逗号分隔列表 / 独立整数变量表达
  const sandbox: SandboxConfig = {
    backend: (env.SANDBOX_BACKEND ??
      DEFAULTS.sandboxBackend) as SandboxBackendChoice,
    allowNetwork: parseBool(
      env.SANDBOX_ALLOW_NETWORK,
      DEFAULTS.sandboxAllowNetwork,
    ),
    writablePaths: parseList(env.SANDBOX_WRITABLE_PATHS),
    limits: parseLimits(env),
    envPassthrough: parseList(env.SANDBOX_ENV_PASSTHROUGH),
  };

  // Langfuse 配置：缺失则后续判定为关闭
  const langfuse: LangfuseConfig = {
    publicKey: env.LANGFUSE_PUBLIC_KEY,
    secretKey: env.LANGFUSE_SECRET_KEY,
    baseURL: env.LANGFUSE_BASE_URL,
  };

  const config: AppConfig = {
    provider: { type: providerType, apiKey, authToken, baseURL, model },
    workdir,
    commandTimeoutMs: parseIntEnv(
      env.COMMAND_TIMEOUT_MS,
      DEFAULTS.commandTimeoutMs,
    ),
    readFileMaxLines: parseIntEnv(
      env.READ_FILE_MAX_LINES,
      DEFAULTS.readFileMaxLines,
    ),
    commandOutputMaxBytes: parseIntEnv(
      env.COMMAND_OUTPUT_MAX_BYTES,
      DEFAULTS.commandOutputMaxBytes,
    ),
    maxIterations: parseIntEnv(env.MAX_ITERATIONS, DEFAULTS.maxIterations),
    maxRepeatedActions: parseIntEnv(
      env.MAX_REPEATED_ACTIONS,
      DEFAULTS.maxRepeatedActions,
    ),
    promptCaching: parseBool(env.PROMPT_CACHING, DEFAULTS.promptCaching),
    historyToolResultMaxBytes: parseIntEnv(
      env.HISTORY_TOOL_RESULT_MAX_BYTES,
      DEFAULTS.historyToolResultMaxBytes,
    ),
    historyCompactionMaxBytes: parseIntEnv(
      env.HISTORY_COMPACTION_MAX_BYTES,
      DEFAULTS.historyCompactionMaxBytes,
    ),
    sandbox,
    langfuse: isLangfuseEnabled(langfuse) ? langfuse : undefined,
  };

  validateConfig(config);
  return config;
}

/** 从 SANDBOX_* 整数变量解析资源上限；未设置的字段保持 undefined（即不限制）。 */
function parseLimits(env: NodeJS.ProcessEnv): ResourceLimits {
  return {
    maxProcesses: parseOptIntEnv(env.SANDBOX_MAX_PROCESSES),
    maxMemoryBytes: parseOptIntEnv(env.SANDBOX_MAX_MEMORY_BYTES),
    cpuTimeSeconds: parseOptIntEnv(env.SANDBOX_CPU_TIME_SECONDS),
  };
}

/** 解析布尔型环境变量；未设置时回落到 fallback。接受 1/true/yes/on（不区分大小写）为真。 */
function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

/** 解析整数型环境变量；未设置或非法时回落到 fallback。 */
function parseIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

/** 解析可选整数型环境变量；未设置或非法时返回 undefined（用于「缺省即不限制」的字段）。 */
function parseOptIntEnv(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) ? n : undefined;
}

/** 解析逗号分隔的列表型环境变量；未设置或全为空白时返回空数组。 */
function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 判断 Langfuse 是否配置齐全（publicKey + secretKey 必须都有才算启用） */
export function isLangfuseEnabled(lf: LangfuseConfig | undefined): boolean {
  return Boolean(lf?.publicKey && lf?.secretKey);
}

/**
 * 校验配置的必需项。
 * 当前仅 anthropic provider 已实现，且必须提供 apiKey。
 */
function validateConfig(config: AppConfig): void {
  if (
    config.provider.type === "anthropic" &&
    !config.provider.apiKey &&
    !config.provider.authToken
  ) {
    throw new Error(
      "缺少 Anthropic 凭证。请在 .env 中设置 ANTHROPIC_API_KEY（x-api-key 方式）或 ANTHROPIC_AUTH_TOKEN（Bearer 方式，常用于代理/网关）。",
    );
  }
}

/**
 * 确保工作目录下存在 .litecode/ 目录，用于存放本地设置（如授权规则）。
 * 目录已存在时不做任何操作。
 *
 * @param workdir 工作目录绝对路径
 * @returns .litecode 目录的绝对路径
 */
export function ensureLitecodeDir(workdir: string): string {
  const dir = join(workdir, ".litecode");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}
