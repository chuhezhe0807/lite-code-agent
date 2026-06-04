/**
 * Lite Code Agent —— 程序入口
 *
 * 启动流程：
 *   1. 加载配置（config.json + 环境变量），校验必需项（如 apiKey）。
 *   2. 确保 .litecode/ 目录并加载授权设置。
 *   3. 构建 LLM 模型、工具集、会话控制器（内部组装授权管理器与主循环图）。
 *   4. 打印启动概览，进入基于 Ink 的 CLI 交互。
 */

import { loadConfig, ensureLitecodeDir, isLangfuseEnabled } from "./config.js";
import { createChatModel } from "./provider.js";
import { loadSettings } from "./permissions/settings.js";
import { selectSandboxBackend } from "./sandbox/detect.js";
import { createTools } from "./tools/index.js";
import { SessionController } from "./cli/controller.js";
import { startCli } from "./cli/app.js";

function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    // 配置错误（如缺少 apiKey）直接给出可读提示并退出
    console.error(`[启动失败] ${(err as Error).message}`);
    process.exit(1);
  }

  // 确保本地设置目录存在，并加载授权设置（不存在则创建默认 settings.local.json）
  const litecodeDir = ensureLitecodeDir(config.workdir);
  const settings = loadSettings(litecodeDir);

  // 构建模型与工具
  let model;
  try {
    model = createChatModel(config);
  } catch (err) {
    console.error(`[模型初始化失败] ${(err as Error).message}`);
    process.exit(1);
  }
  // 能力探测：按平台/配置选出实际生效的沙箱后端（不可用则优雅降级到 none）
  const sandbox = selectSandboxBackend(config);
  const tools = createTools(config, sandbox.backend);

  // 打印启动概览
  console.log("Lite Code Agent 已启动");
  console.log("----------------------------------------");
  console.log(`Provider     : ${config.provider.type}`);
  console.log(`Model        : ${config.provider.model}`);
  console.log(`Base URL     : ${config.provider.baseURL ?? "(默认)"}`);
  console.log(`工作目录     : ${config.workdir}`);
  console.log(`命令超时     : ${config.commandTimeoutMs} ms`);
  console.log(
    `沙箱后端     : ${sandbox.backend.name}${sandbox.degraded ? `（降级自 ${sandbox.intended}）` : ""}`,
  );
  console.log(`隔离等级     : ${sandbox.isolationLevel}`);
  if (sandbox.degraded && sandbox.reason) {
    console.log(`  ⚠ ${sandbox.reason}`);
  }
  console.log(`本地设置目录 : ${litecodeDir}`);
  console.log(
    `Langfuse 监控: ${isLangfuseEnabled(config.langfuse) ? "已启用" : "未启用"}`,
  );
  console.log(
    `授权规则     : allow ${settings.permissions.allow.length} 条 / deny ${settings.permissions.deny.length} 条`,
  );
  console.log("工具         : " + tools.map((t) => t.tool.name).join(", "));
  console.log("----------------------------------------");
  console.log("输入任务开始对话，/exit 退出。\n");

  // 构建会话控制器并进入 Ink CLI
  const controller = new SessionController({
    config,
    model,
    tools,
    settings,
    litecodeDir,
  });
  startCli(controller);
}

main();
