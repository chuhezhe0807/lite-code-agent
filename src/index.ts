/**
 * Lite Code Agent —— 程序入口
 *
 * 当前阶段（US-001 脚手架）：
 *   - 加载配置（config.json + 环境变量）
 *   - 确保 .litecode/ 目录存在
 *   - 打印启动信息，验证整条配置链路可用
 *
 * 后续故事会在此基础上接入：provider 工厂、工具集、LangGraph 主循环、CLI REPL。
 */

import { loadConfig, ensureLitecodeDir, isLangfuseEnabled } from "./config.js";

function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    // 配置错误（如缺少 apiKey）直接给出可读提示并退出
    console.error(`[启动失败] ${(err as Error).message}`);
    process.exit(1);
  }

  // 确保本地设置目录存在
  const litecodeDir = ensureLitecodeDir(config.workdir);

  // 打印启动概览，便于确认配置是否符合预期
  console.log("Lite Code Agent 已启动");
  console.log("----------------------------------------");
  console.log(`Provider     : ${config.provider.type}`);
  console.log(`Model        : ${config.provider.model}`);
  console.log(`Base URL     : ${config.provider.baseURL ?? "(默认)"}`);
  console.log(`工作目录     : ${config.workdir}`);
  console.log(`命令超时     : ${config.commandTimeoutMs} ms`);
  console.log(`本地设置目录 : ${litecodeDir}`);
  console.log(
    `Langfuse 监控: ${isLangfuseEnabled(config.langfuse) ? "已启用" : "未启用"}`,
  );
  console.log("----------------------------------------");
  console.log("（脚手架阶段：agent 主循环与 CLI 将在后续故事中接入）");
}

main();
