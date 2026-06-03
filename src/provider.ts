/**
 * LLM Provider 工厂模块
 *
 * 职责：把配置里的 provider 信息翻译成一个具体的 LangChain ChatModel 实例。
 * Agent 主循环只依赖统一的 BaseChatModel 接口，不关心底层是哪家厂商，
 * 这样未来新增 OpenAI / Ollama 只需在这里扩展一个分支，主循环代码无需改动。
 *
 * 当前已实现：anthropic（默认）。
 * openai / ollama 留有扩展点，但尚未实现（命中时抛出明确错误）。
 */

import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { AppConfig, ProviderConfig } from "./config.js";

/**
 * 创建 Anthropic 模型实例。
 * - apiKey / model 来自配置
 * - baseURL 可选，映射到 ChatAnthropic 的 anthropicApiUrl（用于代理或兼容网关）
 */
function createAnthropic(p: ProviderConfig): BaseChatModel {
  return new ChatAnthropic({
    apiKey: p.apiKey,
    // model 字段在类型上是受限的 union，但实际接受任意模型字符串，这里安全断言
    model: p.model as unknown as string,
    // 仅在配置了 baseURL 时才传，避免覆盖默认官方地址
    ...(p.baseURL ? { anthropicApiUrl: p.baseURL } : {}),
    // Anthropic 接口必须指定 max_tokens，给一个合理默认值
    maxTokens: 4096,
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
      // 扩展点：后续接入 @langchain/openai 的 ChatOpenAI
      throw new Error(
        "provider 'openai' 暂未实现。当前仅支持 anthropic，请修改配置。",
      );
    case "ollama":
      // 扩展点：后续接入 @langchain/ollama 的 ChatOllama
      throw new Error(
        "provider 'ollama' 暂未实现。当前仅支持 anthropic，请修改配置。",
      );
    default: {
      // 穷尽性检查：新增 ProviderType 而忘记处理时，编译期即可发现
      const exhaustive: never = provider.type;
      throw new Error(`未知的 provider 类型：${String(exhaustive)}`);
    }
  }
}
