/**
 * LLM Provider 工厂模块
 *
 * 职责：把配置里的 provider 信息翻译成一个具体的 LangChain ChatModel 实例。
 * Agent 主循环只依赖统一的 BaseChatModel 接口，不关心底层是哪家厂商，
 * 这样未来新增 OpenAI / Ollama 只需在这里扩展一个分支，主循环代码无需改动。
 *
 * 当前已实现：anthropic（默认）、openai、ollama。
 */

import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import { ChatOllama } from "@langchain/ollama";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { AppConfig, ProviderConfig } from "./config.js";

/**
 * 创建 Anthropic 模型实例。
 * - apiKey / authToken / model 来自配置
 * - baseURL 可选，映射到 ChatAnthropic 的 anthropicApiUrl（用于代理或兼容网关）
 * - 鉴权方式：
 *     - 若配置了 authToken（Bearer），通过 clientOptions.authToken 以 `Authorization: Bearer` 发送，
 *       这与 Claude Code 对接 LiteLLM 等代理时的行为一致。
 *     - 否则用 apiKey 以 `x-api-key` 发送。
 *   ChatAnthropic 构造时要求有一个非空 apiKey（否则报错），因此当只有 authToken 时，
 *   把 apiKey 也置为该 token 以通过校验（代理收到的 token 一致，不影响鉴权）。
 */
function createAnthropic(p: ProviderConfig): BaseChatModel {
  const useBearer = Boolean(p.authToken);
  // 凭证：有 authToken 时一律用它（忽略可能过期/错误的 apiKey）。
  // 注意 Anthropic SDK 在 apiKey 与 authToken 同时存在时会同时发送 x-api-key 与 Authorization，
  // 因此这里让两个头都携带同一个有效凭证，避免把错误的 x-api-key 发给代理。
  const credential = p.authToken || p.apiKey;
  return new ChatAnthropic({
    apiKey: credential,
    // model 字段在类型上是受限的 union，但实际接受任意模型字符串，这里安全断言
    model: p.model as unknown as string,
    // 仅在配置了 baseURL 时才传，避免覆盖默认官方地址
    ...(p.baseURL ? { anthropicApiUrl: p.baseURL } : {}),
    // 有 authToken 时用 Bearer 方式鉴权
    ...(useBearer ? { clientOptions: { authToken: p.authToken } } : {}),
    // Anthropic 接口必须指定 max_tokens，给一个合理默认值
    maxTokens: 4096,
    // ChatAnthropic 默认会发送 top_p=-1 / top_k=-1 哨兵值，部分代理（如 LiteLLM）会校验拒绝；
    // 这里覆盖为 undefined，使其在请求体中被省略，交给模型用自身默认采样。
    invocationKwargs: { top_p: undefined, top_k: undefined },
  }) as unknown as BaseChatModel;
}

/**
 * 创建 OpenAI（或 OpenAI 兼容网关，如 LiteLLM/vLLM）模型实例。
 * - apiKey / authToken 都以 `Authorization: Bearer` 发送，二者等价，取其一即可；
 * - baseURL 可选，指向兼容网关；缺省走 OpenAI 官方地址；
 * - maxTokens 给一个合理默认值，模型可在其上下文内自由生成。
 */
function createOpenAI(p: ProviderConfig): BaseChatModel {
  const credential = p.apiKey || p.authToken || "";
  return new ChatOpenAI({
    apiKey: credential,
    model: p.model,
    maxTokens: 4096,
    // 仅在配置了 baseURL 时才传，避免覆盖默认官方地址
    ...(p.baseURL ? { configuration: { baseURL: p.baseURL } } : {}),
  }) as unknown as BaseChatModel;
}

/**
 * 创建 Ollama（本地模型服务）实例。
 * - 无需鉴权；baseURL 指向 Ollama 服务，缺省 http://localhost:11434；
 * - 工具调用需所选模型本身支持 function calling（如 llama3.1、qwen2.5 等）。
 */
function createOllama(p: ProviderConfig): BaseChatModel {
  return new ChatOllama({
    model: p.model,
    baseUrl: p.baseURL || "http://localhost:11434",
  }) as unknown as BaseChatModel;
}

/**
 * Provider 工厂：根据配置返回对应的 ChatModel。
 *
 * @param config 应用配置
 * @returns 统一的 BaseChatModel 实例（已可用于 bindTools）
 * @throws 当 provider 类型尚未实现时抛出明确错误
 */
export function createChatModel(config: AppConfig): BaseChatModel {
  const { provider } = config;
  switch (provider.type) {
    case "anthropic":
      return createAnthropic(provider);
    case "openai":
      return createOpenAI(provider);
    case "ollama":
      return createOllama(provider);
    default: {
      // 穷尽性检查：新增 ProviderType 而忘记处理时，编译期即可发现
      const exhaustive: never = provider.type;
      throw new Error(`未知的 provider 类型：${String(exhaustive)}`);
    }
  }
}
