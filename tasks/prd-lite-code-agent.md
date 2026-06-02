# PRD: Lite Code Agent（轻量级代码 Agent）

## 1. Introduction / Overview

本项目是一个用于**学习如何开发 Agent 应用**的轻量级 code agent，参考 Claude Code 的核心交互模式，使用 **LangGraph + TypeScript** 实现。

Agent 在 CLI 终端中与用户对话，能够理解自然语言任务，调用一组工具来读写本地文件、在受限沙箱中执行代码与项目构建脚本，并通过分级授权机制保护用户的文件系统安全。

核心目标不是做一个生产级产品，而是**通过一个可运行、可读、可扩展的最小系统，理解 Agent 的核心组成**：状态图（StateGraph）、工具调用循环（tool-calling loop）、人在回路（human-in-the-loop）授权、沙箱执行隔离。

**关键技术选型（已确认）：**
- 沙箱方案：`child_process` + 限制（工作目录隔离、路径白名单、执行超时）
- LLM：默认 **Anthropic**（可配置 apiKey / baseURL / model），provider 层可切换
- 交互形态：CLI 终端（类似 Claude Code CLI）
- 授权机制：分级（只读 / 写入 / 执行）+ 记住用户选择，**持久化到 `.litecode/settings.local.json`**（参考 Claude Code）
- 文件编辑：支持整文件 `write_file` 与基于 diff 的局部 `edit_file`
- 可观测性：**可选集成 Langfuse**（不配置也能正常运行）
- 代码规范：全程**中文注释**，可读性优先

## 2. Goals

- 实现一个基于 LangGraph 的 agent 主循环，能自主进行「思考 → 调用工具 → 观察结果 → 继续」的 ReAct 式循环。
- 提供一组核心工具：读文件、列目录、写文件、基于 diff 的局部编辑、执行 shell 命令 / 构建脚本。
- 所有文件写入与命令执行通过**分级授权**保护，危险操作必须经用户确认；用户可选择「记住」，并**持久化到 `.litecode/settings.local.json`** 跨会话生效。
- 提供**受限沙箱执行环境**：命令只能在指定工作目录内运行，限制可访问路径，带执行超时。
- 默认使用 **Anthropic 模型**（支持 apiKey / baseURL / model 配置），provider 层可切换。
- 可选集成 **Langfuse** 做调用链监控，不配置时不影响正常使用。
- 代码结构清晰、**全程中文注释**、易于扩展新工具，作为学习 Agent 开发的参考实现。

## 3. User Stories

### US-001: 项目脚手架与配置加载
**Description:** As a developer, I want 一个可运行的 TypeScript 项目骨架与配置系统, so that 我可以从一个干净的基础上开始构建 agent。

**Acceptance Criteria:**
- [ ] 初始化 TS 项目（`package.json`、`tsconfig.json`、`src/`），可用 `tsx` 或编译后运行。
- [ ] 安装依赖：`@langchain/langgraph`、`@langchain/core`、`@langchain/anthropic`（默认 provider）。
- [ ] 配置从 `config.json` 或环境变量加载：provider 类型、`apiKey`、`baseURL`、`model`、工作目录、超时时间、Langfuse 配置（可选）。
- [ ] 提供 `.env.example` 与一份示例 `config.json`。
- [ ] 启动时自动创建 `.litecode/` 目录（若不存在），用于存放本地授权设置。
- [ ] Typecheck（`tsc --noEmit`）通过。

### US-002: 可切换的 LLM Provider 抽象（默认 Anthropic）
**Description:** As a developer, I want 一个统一的模型接入层, so that 我可以配置 Anthropic 并在未来切换其他 provider 而不改 agent 主逻辑。

**Acceptance Criteria:**
- [ ] 定义一个工厂函数，根据配置返回 LangChain 的 ChatModel 实例。
- [ ] 默认 provider 为 **Anthropic**（`@langchain/anthropic`），支持配置 `apiKey`、`baseURL`、`model`；默认 model 为 `claude-sonnet-4-6`。
- [ ] `apiKey` 缺失时启动给出明确报错；`baseURL` 可选（支持代理 / 兼容网关）。
- [ ] provider 层留出扩展点，未来可加 OpenAI / Ollama 而不改 agent 主循环。
- [ ] 模型必须支持 tool calling（bind tools）。
- [ ] Typecheck 通过。

### US-003: 工具定义 —— 文件读取与目录列举（只读）
**Description:** As a user, I want agent 能读取文件和列出目录, so that 它能理解我的项目结构和代码。

**Acceptance Criteria:**
- [ ] 实现 `read_file(path, offset?, limit?)` 工具：默认只读前 N 行（如 2000 行），支持 `offset`/`limit` 分页。
- [ ] 截断时尾部标注 `[文件还有 X 行未显示，用 offset=... 继续读]`，把翻页控制权交给模型。
- [ ] 实现 `list_dir(path)` 工具：返回目录下的文件/子目录列表，条目过多时给总数 + 前 N 条并提示用更具体路径。
- [ ] 路径必须经过工作目录白名单校验，越界路径返回明确错误而非读取。
- [ ] 只读工具默认放行（见 US-007）。
- [ ] Typecheck 通过。

### US-004: 工具定义 —— 文件写入（需授权）
**Description:** As a user, I want agent 能创建和修改文件, so that 它能帮我写代码, 但我要先批准。

**Acceptance Criteria:**
- [ ] 实现 `write_file(path, content)` 工具：写入/覆盖文件。
- [ ] 写入前显示将要写入的路径与内容摘要（或 diff），等待授权。
- [ ] 路径越界（超出工作目录白名单）直接拒绝。
- [ ] 写入工具归类为「写入」授权级别。
- [ ] Typecheck 通过。

### US-005: 工具定义 —— 基于 diff 的局部编辑（需授权）
**Description:** As a user, I want agent 能对现有文件做局部修改而非整文件覆盖, so that 改动更精确、可见、可控。

**Acceptance Criteria:**
- [ ] 实现 `edit_file(path, old_string, new_string)` 工具：在文件中精确替换片段。
- [ ] `old_string` 在文件中不唯一或不存在时返回明确错误，不做修改。
- [ ] 修改前向用户展示 diff（前后对比）并等待授权。
- [ ] 路径越界（超出工作目录白名单）直接拒绝。
- [ ] 归类为「写入」授权级别。
- [ ] Typecheck 通过。

### US-006: 工具定义 —— 沙箱命令执行（需授权）
**Description:** As a user, I want agent 能在受限沙箱中运行命令和构建脚本, so that 它能执行测试、构建、安装依赖等任务而不威胁我的系统。

**Acceptance Criteria:**
- [ ] 实现 `run_command(command)` 工具：通过 `child_process` 执行。
- [ ] 执行时 `cwd` 锁定为配置的工作目录，进程不能在工作目录之外写文件（通过 cwd + 路径策略约束）。
- [ ] 强制执行超时（可配置，默认如 30s），超时则杀掉进程并返回错误。
- [ ] 捕获并返回 stdout、stderr、退出码；始终完整返回 exit code。
- [ ] 输出按总字节预算截断（如 30KB），超预算时保留**头部 N 行 + 尾部 M 行**，中间用 `... [省略 X 行] ...` 占位（关键报错通常在尾部）。
- [ ] 执行前向用户展示完整命令并按授权规则处理（见 US-007）。
- [ ] Typecheck 通过。

### US-007: 模式匹配授权与「记住选择」持久化机制
**Description:** As a user, I want 用「工具名 + 参数模式」的规则来授权（参考 Claude Code），并能把决定持久化, so that 我能精细控制哪些操作免询问，下次会话也生效。

**Acceptance Criteria:**
- [ ] 授权规则采用 `工具名(参数模式)` 格式，支持通配符 `*`，例如 `Bash(npx tsc *)`、`WriteFile(src/*)`、`ReadFile(*)`。
- [ ] 规则存于 `.litecode/settings.local.json` 的 `permissions.allow` 与 `permissions.deny` 两个列表中（结构对齐 Claude Code）。
- [ ] 工具调用前先做匹配：命中 `deny` → 直接拒绝；命中 `allow` → 免询问放行；都不命中 → 提示用户。
- [ ] 只读工具（`ReadFile`/`ListDir`）默认放行，无需出现在 allow 列表。
- [ ] 提示用户时展示「工具名 + 具体参数」与操作详情；用户可选：`y`（本次允许）/ `n`（本次拒绝）/ `a`（始终允许，写入 allow 规则）/ `d`（始终拒绝，写入 deny 规则）。
- [ ] 选 `a`/`d` 时，根据当前调用生成一条可复用的模式规则（如把具体命令泛化为 `Bash(npx tsc *)`）并写回 `.litecode/settings.local.json`。
- [ ] 启动时若文件不存在则创建带默认结构的文件；存在则加载已记住的规则。
- [ ] 拒绝时，将「用户拒绝了该操作」作为工具结果返回给 agent，使其能调整策略而非崩溃。
- [ ] Typecheck 通过。

### US-008: LangGraph Agent 主循环（StateGraph）
**Description:** As a developer, I want 用 LangGraph 的 StateGraph 编排 agent 的思考-行动循环, so that 我能清楚理解 agent 的状态流转。

**Acceptance Criteria:**
- [ ] 定义图状态（messages 累积）。
- [ ] 节点：`agent`（调用 LLM，可能产生 tool_calls）、`tools`（执行工具，含授权拦截）。
- [ ] 条件边：若 LLM 返回 tool_calls 则进入 `tools` 节点，否则结束。
- [ ] `tools` 执行完回到 `agent` 节点，形成循环。
- [ ] 有最大迭代次数保护，防止无限循环。
- [ ] Typecheck 通过。

### US-009: CLI 交互界面
**Description:** As a user, I want 一个命令行对话界面, so that 我可以像用 Claude Code 一样输入任务并看到 agent 的工作过程。

**Acceptance Criteria:**
- [ ] 启动后进入 REPL 循环：读取用户输入 → 运行 agent → 打印结果 → 等待下一条。
- [ ] 采用**分步骤块状展示**（非流式 token）：每一步打印一个块 —— agent 思考 / 工具调用（名称+参数）/ 工具结果。
- [ ] 授权提示在终端内交互（见 US-007）。
- [ ] 支持退出命令（如 `/exit`）。
- [ ] 在一个示例项目目录上手动跑通：让 agent 读文件、写一个新文件、运行一个构建/测试命令。

### US-010: 可选 Langfuse 监控集成
**Description:** As a developer, I want 把 agent 的调用链上报到 Langfuse, so that 我能观测每次 LLM 调用与工具执行，便于调试和学习。

**Acceptance Criteria:**
- [ ] 通过配置（`publicKey`、`secretKey`、`baseURL`）启用 Langfuse；三者缺失时**自动跳过**，程序正常运行。
- [ ] 启用时，使用 LangChain 的 callback handler 将 LLM 调用与工具执行链路上报到 Langfuse。
- [ ] 未配置 Langfuse 不引入运行时错误、不阻塞主流程。
- [ ] README 说明如何配置 Langfuse（可选）。
- [ ] Typecheck 通过。

### US-011: 文档与示例
**Description:** As a learner, I want 一份说明文档和可复现的示例, so that 我能理解每个模块并自己扩展。

**Acceptance Criteria:**
- [ ] `README.md`：安装、配置、运行步骤，架构图/说明（状态图、工具、授权流、Langfuse）。
- [ ] 提供一个 `examples/` 示例工作目录供 agent 操作演示。
- [ ] 关键模块（图、工具、授权、provider）有**中文解释性注释**。

## 4. Functional Requirements

- FR-1: 系统必须基于 LangGraph 的 `StateGraph` 实现 agent 主循环，包含 `agent` 与 `tools` 两个核心节点及条件边。
- FR-2: 系统必须提供工具：`read_file`、`list_dir`、`write_file`、`edit_file`、`run_command`。
- FR-3: 所有涉及路径的工具必须将路径限制在配置的工作目录白名单内，越界操作必须被拒绝。
- FR-4: `run_command` 必须使用 `child_process` 执行，锁定 `cwd`，并强制可配置的执行超时。
- FR-5: `edit_file` 必须基于 `old_string`/`new_string` 精确替换，`old_string` 不唯一或不存在时报错且不修改。
- FR-6: 工具结果必须做预算截断：`read_file` 支持 offset/limit 分页并标注剩余量；`run_command` 输出按字节预算保留头部+尾部、中间省略占位；预算可配置。
- FR-7: 授权必须采用 `工具名(参数模式)` 模式匹配，规则存于 `.litecode/settings.local.json` 的 `permissions.allow` / `permissions.deny`；deny 优先，allow 免询问，未命中则提示用户。
- FR-8: 授权交互必须支持「本次允许 / 本次拒绝 / 始终允许（写入 allow 规则）/ 始终拒绝（写入 deny 规则）」，并把当前调用泛化为可复用的模式规则持久化。
- FR-9: 用户拒绝某操作时，系统必须把拒绝信息作为工具结果回传给 agent，而不是终止程序。
- FR-10: 系统必须通过工厂模式支持可切换的 LLM provider，默认 **Anthropic**，默认 model `claude-sonnet-4-6`，支持 `apiKey` / `baseURL` / `model` 配置。
- FR-11: 系统必须提供 CLI REPL 交互界面，采用分步骤块状展示 agent 的思考、工具调用与结果（非流式 token）。
- FR-12: 系统必须有最大迭代次数限制以防止无限工具调用循环。
- FR-13: 配置（provider、模型、工作目录、超时、白名单、结果预算、Langfuse）必须可通过配置文件 / 环境变量设置。
- FR-14: 系统必须支持可选的 Langfuse 监控；当 Langfuse 配置缺失时自动跳过且不影响运行。
- FR-15: 项目代码必须包含中文注释，关键模块（图、工具、授权、provider）需有解释性说明。

## 5. Non-Goals（明确不做）

- 不实现强隔离沙箱（不用 Docker / VM / 云沙箱）；本版本仅用 `child_process` + 路径与超时限制，属于「学习级」隔离，不保证对抗恶意代码。
- 不做 Web UI 或图形界面，仅 CLI。
- 不做对话历史 / 会话记录的持久化数据库（仅授权选择持久化到 `.litecode/settings.local.json`，对话历史不落盘）。
- 不做用户系统、权限账户、远程部署。
- 不做代码语义索引 / 向量检索 / RAG（agent 仅靠工具实时读取文件）。
- 不追求生产级安全与性能，优先可读性与学习价值。
- 不实现自动 git 操作、PR 创建等高级工作流。

## 6. Technical Considerations

- **依赖**：`@langchain/langgraph`、`@langchain/core`、`@langchain/anthropic`（默认 provider）；可选 `langfuse-langchain`（监控）；运行用 `tsx`，类型检查用 `typescript`。预留 `@langchain/openai` / `@langchain/ollama` 作为后续扩展。
- **`.litecode/` 目录**：放在工作目录根下，存 `settings.local.json`（授权规则等本地设置），参考 Claude Code；建议加入 `.gitignore`。示例结构：
  ```json
  {
    "permissions": {
      "allow": [
        "ReadFile(*)",
        "Bash(npx tsc *)",
        "Bash(git add *)"
      ],
      "deny": [
        "Bash(rm -rf *)"
      ]
    }
  }
  ```
- **结果截断**：`read_file` 走 offset/limit 分页；`run_command` 按字节预算保留头+尾，中间省略占位；预算项写进 config。
- **Langfuse 集成**：用 `langfuse-langchain` 的 `CallbackHandler`，在创建模型/图调用时按需注入；配置缺失则不创建 handler。
- **沙箱限制策略**：
  - `cwd` 固定为工作目录；所有文件工具路径先 `path.resolve` 再校验是否以工作目录前缀开头。
  - `run_command` 用 `child_process.spawn` 配合 `timeout` 杀进程；可选限制环境变量。
  - 明确告知用户：这是学习级隔离，不要在其上运行不可信代码。
- **Tool calling**：依赖 provider 的 tool-calling 能力；Ollama 需选用支持 function calling 的模型（如 `llama3.1`、`qwen2.5` 等），启动时校验。
- **授权拦截点**：在 LangGraph 的 `tools` 节点（或自定义 ToolNode）内、实际执行工具前插入授权检查，便于集中管理。
- **可扩展性**：工具以数组注册，新增工具只需实现 + 注册 + 标注授权级别。

## 7. Success Metrics

- 能在本地用 Ollama 零成本跑通完整的「输入任务 → agent 调用工具 → 完成」闭环。
- 在示例项目上成功演示：读文件、写新文件、运行构建/测试命令三类操作。
- 授权机制有效：敏感操作被拦截确认，「始终允许」后不再重复询问。
- 越界路径与超时命令被正确拒绝/中断。
- 一位不熟悉 LangGraph 的开发者能通过 README 在 15 分钟内跑起来并理解主循环。

## 8. Open Questions

- 模式规则的「泛化策略」如何定？例如把 `npx tsc --noEmit` 泛化成 `Bash(npx tsc *)` 的规则——初版可只做简单的「命令首段 + `*`」泛化，并在写入前让用户确认生成的规则文本。
- 结果预算的具体数值（read 默认行数、run_command 字节上限、头/尾保留行数）取多少合适？建议先用 read 2000 行、run_command 30KB、头 50 行 + 尾 50 行，后续按模型上下文调。

> 已确认决策：支持 `edit_file`（diff 局部编辑）；授权采用 Claude Code 式 `工具名(参数模式)` 模式匹配 + allow/deny，持久化到 `.litecode/settings.local.json`；默认 Anthropic provider，默认 model `claude-sonnet-4-6`；CLI 分步骤块状展示；工具结果按预算截断（read 分页 / exec 头尾保留）；可选 Langfuse 监控。
