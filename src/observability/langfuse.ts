/**
 * 可选的 Langfuse 监控集成
 *
 * Langfuse 是一个开源的 LLM 可观测平台。配置齐全（publicKey + secretKey）时，
 * 这里创建一个 LangChain CallbackHandler，挂到图调用上，就能把每次 LLM 调用、
 * 工具执行的链路上报到 Langfuse 便于调试。
 *
 * 设计原则：**完全可选**。未配置时返回 undefined，主流程不受任何影响、不报错。
 *
 * 本地自托管：仓库内 docker-compose.yml 可一键起 Langfuse（web 在 http://localhost:3000），
 * 在其中创建项目拿到 public/secret key，填到 .env 的 LANGFUSE_* 即可启用。
 */

import { CallbackHandler } from "langfuse-langchain";
import type { AppConfig } from "../config.js";
import { isLangfuseEnabled } from "../config.js";

/**
 * 根据配置创建 Langfuse CallbackHandler。
 * @returns 配置齐全时返回 handler；否则返回 undefined（监控关闭）
 */
export function createLangfuseHandler(
  config: AppConfig,
): CallbackHandler | undefined {
  const lf = config.langfuse;
  if (!isLangfuseEnabled(lf)) return undefined;

  return new CallbackHandler({
    publicKey: lf!.publicKey,
    secretKey: lf!.secretKey,
    // baseUrl 指向自托管或云端 Langfuse；本地默认 http://localhost:3000
    baseUrl: lf!.baseURL ?? "http://localhost:3000",
  });
}
