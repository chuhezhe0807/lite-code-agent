/**
 * 配置加载模块
 *
 * 职责：把「命令行运行时所需的所有配置」从两处来源合并成一个强类型对象：
 *   1. 工作目录下的 config.json（可选，结构化配置）
 *   2. 环境变量 / .env 文件（敏感信息如 apiKey 优先放这里）
 *
 * 合并优先级：环境变量 > config.json > 内置默认值。
 * 这样 apiKey 之类的密钥可以只放在 .env 里，不必写进会被提交的 config.json。
 */

import { existsSync, readFileSync, mkdirSync } from "node:fs";
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
  /** Agent 主循环最大迭代次数，防止无限工具调用，默认 25 */
  maxIterations: number;
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
  /** 沙箱配置（US-016） */
  sandbox: SandboxConfig;
  /** Langfuse 监控配置（可选） */
  langfuse?: LangfuseConfig;
}

/** config.json 的结构（所有字段均可选，缺失时回落到默认值或环境变量） */
interface RawConfigFile {
  provider?: Partial<ProviderConfig>;
  workdir?: string;
  commandTimeoutMs?: number;
  readFileMaxLines?: number;
  commandOutputMaxBytes?: number;
  maxIterations?: number;
  promptCaching?: boolean;
  historyToolResultMaxBytes?: number;
  sandbox?: Partial<SandboxConfig>;
  langfuse?: LangfuseConfig;
}

/** 内置默认值 */
const DEFAULTS = {
  providerType: "anthropic" as ProviderType,
  model: "claude-sonnet-4-6",
  commandTimeoutMs: 30_000,
  readFileMaxLines: 2000,
  commandOutputMaxBytes: 30 * 1024,
  maxIterations: 25,
  promptCaching: false,
  historyToolResultMaxBytes: 8192,
  sandboxBackend: "auto" as SandboxBackendChoice,
  sandboxAllowNetwork: true,
};

/**
 * 读取 config.json（若存在）。文件不存在时返回空对象，不报错。
 * @param cwd 当前工作目录
 */
function readConfigFile(cwd: string): RawConfigFile {
  const configPath = join(cwd, "config.json");
  if (!existsSync(configPath)) {
    return {};
  }
  try {
    const text = readFileSync(configPath, "utf-8");
    return JSON.parse(text) as RawConfigFile;
  } catch (err) {
    throw new Error(
      `解析 config.json 失败（${configPath}）：${(err as Error).message}`,
    );
  }
}

/**
 * 加载并校验完整配置。
 *
 * @param cwd 进程当前工作目录，默认 process.cwd()
 * @returns 合并后的强类型配置对象
 * @throws 当缺少必需的 apiKey 时抛出明确错误
 */
export function loadConfig(cwd: string = process.cwd()): AppConfig {
  const file = readConfigFile(cwd);

  // provider 类型：环境变量 > config.json > 默认 anthropic
  const providerType = (process.env.PROVIDER_TYPE ??
    file.provider?.type ??
    DEFAULTS.providerType) as ProviderType;

  // apiKey：优先环境变量（不同 provider 用各自惯用的环境变量名）
  const apiKey =
    process.env.ANTHROPIC_API_KEY ??
    process.env.LLM_API_KEY ??
    file.provider?.apiKey ??
    "";

  // authToken：Bearer 鉴权，常用于代理/网关（Claude Code 用 ANTHROPIC_AUTH_TOKEN）
  const authToken =
    process.env.ANTHROPIC_LLM_AUTH_TOKEN ??
    process.env.LLM_AUTH_TOKEN ??
    file.provider?.authToken;

  const baseURL =
    process.env.ANTHROPIC_BASE_URL ??
    process.env.LLM_BASE_URL ??
    file.provider?.baseURL;

  const model =
    process.env.LLM_MODEL ?? file.provider?.model ?? DEFAULTS.model;

  // 工作目录：环境变量 > config.json > 当前目录；统一转为绝对路径
  const workdir = resolve(
    process.env.WORKDIR ?? file.workdir ?? cwd,
  );

  // 沙箱配置：环境变量 > config.json > 默认
  const sandbox: SandboxConfig = {
    backend: (process.env.SANDBOX_BACKEND ??
      file.sandbox?.backend ??
      DEFAULTS.sandboxBackend) as SandboxBackendChoice,
    allowNetwork: parseBool(
      process.env.SANDBOX_ALLOW_NETWORK,
      file.sandbox?.allowNetwork ?? DEFAULTS.sandboxAllowNetwork,
    ),
    writablePaths: file.sandbox?.writablePaths ?? [],
    limits: file.sandbox?.limits ?? {},
    envPassthrough: file.sandbox?.envPassthrough ?? [],
  };

  // Langfuse 配置：三个字段任意来源，缺失则后续判定为关闭
  const langfuse: LangfuseConfig = {
    publicKey: process.env.LANGFUSE_PUBLIC_KEY ?? file.langfuse?.publicKey,
    secretKey: process.env.LANGFUSE_SECRET_KEY ?? file.langfuse?.secretKey,
    baseURL: process.env.LANGFUSE_BASE_URL ?? file.langfuse?.baseURL,
  };

  const config: AppConfig = {
    provider: { type: providerType, apiKey, authToken, baseURL, model },
    workdir,
    commandTimeoutMs: file.commandTimeoutMs ?? DEFAULTS.commandTimeoutMs,
    readFileMaxLines: file.readFileMaxLines ?? DEFAULTS.readFileMaxLines,
    commandOutputMaxBytes:
      file.commandOutputMaxBytes ?? DEFAULTS.commandOutputMaxBytes,
    maxIterations: file.maxIterations ?? DEFAULTS.maxIterations,
    promptCaching: parseBool(
      process.env.PROMPT_CACHING,
      file.promptCaching ?? DEFAULTS.promptCaching,
    ),
    historyToolResultMaxBytes:
      file.historyToolResultMaxBytes ?? DEFAULTS.historyToolResultMaxBytes,
    sandbox,
    langfuse: isLangfuseEnabled(langfuse) ? langfuse : undefined,
  };

  validateConfig(config);
  return config;
}

/** 解析布尔型环境变量；未设置时回落到 fallback。接受 1/true/yes/on（不区分大小写）为真。 */
function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
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
