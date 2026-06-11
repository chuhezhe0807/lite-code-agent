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

### US-009: 基于 Ink 的 CLI 交互框架
**Description:** As a user, I want 一个用 Ink 渲染的命令行界面, so that 我能像用 Claude Code 一样输入任务、看到美化的过程展示。

**Acceptance Criteria:**
- [ ] 引入 `ink`、`react`、`ink-text-input` 依赖，用 Ink App 渲染主界面。
- [ ] REPL 循环：输入任务（`ink-text-input` 或 `useInput`）→ 运行 agent → 渲染过程 → 等待下一条。
- [ ] 工具调用渲染为带边框/颜色的块：工具名 + 参数（高亮）+ 结果（截断后）。
- [ ] 渲染层从命令式 `console.log` 改为状态驱动的 React 组件；agent 事件通过回调/事件流推给 UI。
- [ ] agent 运行期间禁用输入框，结束后恢复。
- [ ] 授权提示在 Ink 界面内交互（见 US-007）。
- [ ] 支持退出命令（如 `/exit`）。
- [ ] 在一个示例项目目录上手动跑通：让 agent 读文件、写一个新文件、运行一个构建/测试命令。

### US-010: 思考阶段动画
**Description:** As a user, I want 在 agent 等待 LLM 响应时看到动态指示, so that 我知道它在工作而不是卡死（参考 Claude Code）。

**Acceptance Criteria:**
- [ ] 用 `ink-spinner` 显示旋转动画 + 状态文案（如「思考中…」，可在一组词间轮换：思考中/分析中/规划中）。
- [ ] 显示已用时计数（秒，每秒刷新，如 `思考中… (3s)`）。
- [ ] 显示可中断提示文案（如 `按 Esc 中断`）；中断功能由 US-012 实现。
- [ ] LLM 返回后动画消失，进入下一阶段渲染。
- [ ] 仅用于「等待 LLM」阶段，仍是分步骤块状、非流式 token。

### US-011: Todo 列表实时勾选
**Description:** As a user, I want agent 维护一个 todo 列表并在 UI 中实时勾选, so that 我能看到任务拆解与进度（参考 Claude Code 的 TodoWrite）。

**Acceptance Criteria:**
- [ ] 新增 `update_todos` 工具：agent 主动传入 todo 项及其状态（pending / in_progress / completed）。
- [ ] todo 状态进入 LangGraph 图状态，与对话消息一起流转。
- [ ] Ink 渲染列表，状态字形：`○` 待办 / `◐`（或 spinner）进行中 / `✓` 已完成（绿色）。
- [ ] agent 更新某项状态时列表**原地刷新**，不重复打印整段。
- [ ] 只有 agent 调用 `update_todos` 才产生 todo，不由 UI 自动推断。

### US-012: Esc 中断运行中的 agent
**Description:** As a user, I want 按 Esc 中断正在进行的 agent 运行, so that 我能在它跑偏或耗时过长时及时叫停。

**Acceptance Criteria:**
- [ ] 用 `AbortController`/`AbortSignal` 贯穿 agent 主循环（LLM 调用与工具执行均可被取消）。
- [ ] Ink 界面监听 Esc 键（`useInput`），触发 abort。
- [ ] 中断后停止当前迭代，向用户显示「已中断」并恢复输入框等待下一条。
- [ ] 中断时正在执行的 `run_command` 子进程被杀掉（复用超时杀进程逻辑）。
- [ ] 中断不导致程序崩溃，状态可继续下一轮对话。

### US-013: 可选 Langfuse 监控集成
**Description:** As a developer, I want 把 agent 的调用链上报到 Langfuse, so that 我能观测每次 LLM 调用与工具执行，便于调试和学习。

**Acceptance Criteria:**
- [ ] 通过配置（`publicKey`、`secretKey`、`baseURL`）启用 Langfuse；三者缺失时**自动跳过**，程序正常运行。
- [ ] 启用时，使用 LangChain 的 callback handler 将 LLM 调用与工具执行链路上报到 Langfuse。
- [ ] 未配置 Langfuse 不引入运行时错误、不阻塞主流程。
- [ ] README 说明如何配置 Langfuse（可选）。
- [ ] Typecheck 通过。

### US-014: 文档与示例
**Description:** As a learner, I want 一份说明文档和可复现的示例, so that 我能理解每个模块并自己扩展。

**Acceptance Criteria:**
- [ ] `README.md`：安装、配置、运行步骤，架构图/说明（状态图、工具、授权流、Ink UI、Langfuse）。
- [ ] 提供一个 `examples/` 示例工作目录供 agent 操作演示。
- [ ] 关键模块（图、工具、授权、provider、UI）有**中文解释性注释**。

### US-015: 降低 token 消耗（输入/输出优化）
**Description:** As a 维护者, I want 在不影响功能的前提下减少每轮对话的 token 消耗, so that 长会话/多轮工具调用更省钱。（后续优化项）

**Acceptance Criteria:**
- [ ] 收紧系统提示：指示模型不复述工具结果、只给精简最终结论，减少冗余**输出** token。
- [ ] 探测 LLM 网关（如 LiteLLM 代理）是否支持 Anthropic prompt caching；支持则对系统提示 + 工具定义 + 稳定历史加 `cache_control` 以省**输入** token（多轮里最大的杠杆）。
- [ ] 工具输出预算（`commandOutputMaxBytes` / `readFileMaxLines`）可调小；可选：历史中用过的大工具结果做截断/压缩，避免每轮重发。
- [ ] 明确（代码/文档）：UI 的展示裁剪（`clampCount`）仅影响显示，**不**减少发给模型的 token。

> 概念澄清（便于后续实现）：① 工具结果是**下一轮的输入 token**（不是模型输出）；② 工具调用参数是模型必需的输出，省不掉；③ 模型每步的解说 prose 才是可省的输出 token；④ 多轮里每轮重发全部历史是输入 token 大头，prompt caching 收益最大。

---

> **Epic：跨平台原生沙箱隔离（US-016 ~ US-020）**
> 现状（US-006）只用 `child_process` + cwd 锁定 + 超时，子进程仍可读写整个文件系统、访问网络、继承全部环境变量（含 API Key），隔离基本为零。本 Epic 在**不引入 Docker / VM / 云沙箱**的前提下，调用各操作系统**自带**的隔离机制把隔离强度提到「可用级」：macOS 用 Seatbelt（`sandbox-exec`），Linux 用 bubblewrap / Landlock，Windows 用 Job Object + 受限令牌（弱隔离，并引导 WSL）。设计原则：**能力探测 + 优雅降级**——平台无对应机制时回退到现状行为并明确告警，绝不因此崩溃或阻断使用。
> 这会更新 Non-Goal 第 1 条：从「仅 child_process 学习级隔离」演进为「OS 原生机制隔离（仍不含 Docker/VM/云）」。

### US-016: 跨平台沙箱后端抽象与能力探测
**Description:** As a developer, I want 一个按平台选择隔离后端的沙箱抽象层, so that 上层 `run_command` 无需关心 OS 差异，且在缺少原生机制时能安全降级。

**Acceptance Criteria:**
- [ ] 定义统一的 `SandboxBackend` 接口（如 `wrapCommand(command, policy) -> {file, args}` 或 `spawnSandboxed(...)`），把「如何把一条命令包裹进隔离环境」与「执行/超时/中断」解耦；现有 `runInSandbox` 改为调用选定的 backend。
- [ ] 定义 `SandboxPolicy`：可写路径白名单（默认 cwd + 系统 tmp + 包管理器缓存如 `~/.npm`）、是否允许网络、资源上限（内存/进程数/CPU 时间，见 US-020）。
- [ ] 启动时做**能力探测**：检测当前平台可用的最强后端（macOS→seatbelt；Linux→bwrap/landlock；Windows→jobobject），探测结果与「当前隔离等级」打印/记录，并可在配置中查看。
- [ ] 配置项 `sandbox.backend`：`auto`（默认，按平台自动选）/ 指定后端 / `none`（显式关闭隔离，仅 cwd+超时）。
- [ ] **优雅降级**：选定后端不可用（如 Linux 未装 bwrap）时，回退到 `none` 行为并打印明确告警（说明降级原因与隔离风险），不崩溃、不阻断命令执行。
- [ ] 越权/路径策略仍由现有工作目录白名单兜底（沙箱是额外一层，不是唯一一层）。
- [ ] 代码含中文注释；Typecheck passes。

### US-017: macOS Seatbelt 后端（sandbox-exec）
**Description:** As a macOS user, I want 命令在 Seatbelt 沙箱里执行, so that 子进程默认不能写工作目录之外、可选切断网络。

**Acceptance Criteria:**
- [ ] 实现 seatbelt backend：用 `sandbox-exec -p <profile>` 包裹命令执行。
- [ ] 动态生成 SBPL profile：`(deny default)` 起步，按 `SandboxPolicy` 放行——`file-write*` 仅限可写白名单（cwd / tmp / 缓存），`file-read*` 可全放行或按需收紧，`process-exec`/`process-fork` 放行。
- [ ] 网络策略：`policy.allowNetwork=false` 时 profile 不含 `(allow network*)`，实现网络切断；为 `true` 时放行。
- [ ] profile 中的路径正确转义（含空格/特殊字符的 cwd 不破坏 profile）。
- [ ] 验证：在沙箱内写 cwd 成功、写 cwd 外（如 `~/Desktop`）被拒；`allowNetwork=false` 时 `curl`/`ping` 失败。
- [ ] `sandbox-exec` 不存在（极少见）时按 US-016 降级。
- [ ] 代码含中文注释；Typecheck passes。

### US-018: Linux bubblewrap / Landlock 后端
**Description:** As a Linux user, I want 命令在 bubblewrap（或 Landlock）里执行, so that 获得 namespace 级别的文件/网络隔离。

**Acceptance Criteria:**
- [ ] 实现 bwrap backend：用 `bwrap` 包裹命令——只读绑定必要系统目录（`/usr`、`/bin`、`/lib` 等），可写白名单（cwd / tmp / 缓存）以 `--bind` 挂载，其余 `--ro-bind` 或不挂载。
- [ ] 网络策略：`allowNetwork=false` 时加 `--unshare-net` 切断网络；为 `true` 时共享网络。
- [ ] 进程隔离：`--unshare-pid`、`--die-with-parent`（父进程退出时子进程一并清理）。
- [ ] 可选：探测到内核支持 Landlock 时提供轻量 LSM 后端作为 bwrap 的替代/补充（标注为可选增强，不阻塞本 US）。
- [ ] 验证：写 cwd 成功、写白名单外被拒；`--unshare-net` 下网络不可达。
- [ ] `bwrap` 未安装时按 US-016 降级并提示安装方式。
- [ ] 代码含中文注释；Typecheck passes。

### US-019: Windows 后端（Job Object + 受限令牌，弱隔离 + WSL 引导）
**Description:** As a Windows user, I want 在 Windows 上获得力所能及的隔离与资源限制, so that 至少能防失控进程，并被引导到更强的 WSL 方案。

**Acceptance Criteria:**
- [ ] 实现 Windows backend：用 **Job Object** 约束进程组——设置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`（父退出/中断时整组进程被杀）、进程数与内存上限（对接 US-020）。
- [ ] 文件隔离能力有限：明确文件越界主要仍靠工作目录白名单（应用层）兜底，沙箱层只提供「进程组管控 + 资源限制」；如可行，可探索受限令牌（restricted token）降低权限作为增强。
- [ ] 启动时**如实告知**：Windows 原生隔离弱于 macOS/Linux，建议在 **WSL2** 中运行本工具以获得 Linux（bwrap）级隔离，并在文档给出步骤。
- [ ] Job Object 不可用或调用失败时按 US-016 降级（cwd+超时），不崩溃。
- [ ] 验证：在 Windows（或 CI/WSL 上尽量模拟）下，中断/超时能杀掉整棵进程树；越界写被白名单拦截。
- [ ] 代码含中文注释；Typecheck passes。

### US-020: 跨平台通用加固（进程树终止 / 环境清洗 / 资源限制 / 网络默认策略）
**Description:** As a maintainer, I want 一组与后端无关、各平台都生效的加固, so that 即便降级到 `none` 也比现状更安全，且修复现有隔离漏洞。

**Acceptance Criteria:**
- [ ] **整棵进程树终止**：修复现状只杀 shell 而 `npm run`→node 等孙进程存活的问题——POSIX 用 `detached:true` + `process.kill(-pid, SIGKILL)` 杀进程组；Windows 用 Job Object（US-019）；超时与 Esc 中断（US-012）均复用此逻辑。
- [ ] **环境变量清洗**：不再整体继承 `process.env`，改为最小白名单（`PATH`、`HOME`/`USERPROFILE`、`LANG`、必要的代理变量等），避免把 `ANTHROPIC_API_KEY` 等密钥泄漏给被执行命令；白名单可配置。
- [ ] **资源限制**：POSIX 经 `ulimit`（进程数 `-u`、虚拟内存 `-v`、CPU 时间 `-t`）或后端原生能力；Windows 经 Job Object，提供 fork 炸弹 / 内存耗尽的基础防护，阈值可配置。
- [ ] **网络默认策略**：在 `SandboxPolicy` 暴露 `allowNetwork`，默认值与权衡写入文档（注意 `npm install` 等需联网，默认放行；提供按需切断的配置）。
- [ ] 验证：fork 炸弹被进程数上限挡住；中断后无残留子进程；子进程 `env` 中不含密钥。
- [ ] 代码含中文注释；Typecheck passes。

### US-021: 授权与沙箱联动（让用户看清「在沙箱里要执行什么」）
**Description:** As a user, I want 在批准命令前看到它将在沙箱中执行的具体内容与作用域, so that 我能基于「命令文本 + 它能改动什么」做知情决策，而不是盲批一个命令名。

**Acceptance Criteria:**
- [ ] 复用 US-007 的授权流（键盘方向键选择「本次允许/本次拒绝/始终允许/始终拒绝」+ 模式规则持久化），不另起一套机制；本 US 只增强「展示」，不改授权判定模型。
- [ ] **沿用 Claude Code 的询问策略**：只读工具（`read_file`/`list_dir`）默认放行；**执行类（`run_command`，含脚本执行）与写文件类（`write_file`/`edit_file`）一律询问**，不做「这条命令是读还是写」的启发式区分。唯一的免询问途径是 US-007 的 `allow` 模式规则命中（如用户主动添加 `Bash(npm test *)`）。
- [ ] 授权弹窗除展示**完整命令文本**外，附带该命令的**沙箱作用域摘要**：选定后端（seatbelt/bwrap/jobobject/none）、可写路径白名单、是否允许网络、资源上限。
- [ ] **降级时强提示**：当后端为 `none`（无原生隔离）时，在弹窗显著标注「无沙箱隔离，命令将以当前用户权限直接运行」，让用户知道风险等级随平台/降级变化。
- [ ] 越权与作用域一致性：弹窗展示的可写白名单必须与实际传给沙箱后端的 `SandboxPolicy` 一致（展示即真实生效，不得误导）。
- [ ] 拒绝时按 US-007 将拒绝信息作为工具结果回传给 agent，不崩溃。
- [ ] 代码含中文注释；Typecheck passes。

### US-022: 只读工具 —— 按内容正则搜索（grep）
**Description:** As a user, I want agent 能按正则在项目里搜索文件内容, so that 它能快速定位符号/关键字所在的文件与行，而不必盲目逐个读文件。

**Acceptance Criteria:**
- [ ] 实现 `grep(pattern, path?, include?)` 工具：在工作目录内按正则搜索文件内容，命中以 `文件:行号:行内容` 形式返回。
- [ ] `pattern` 为正则字符串；`path` 可选限定搜索子目录（默认工作目录根 `.`）；`include` 可选按文件名 glob 过滤（如 `*.ts`）。
- [ ] 路径经 `resolveSafePath` 工作目录白名单校验，越界返回明确错误而非搜索。
- [ ] 默认跳过常见噪音目录（`node_modules`/`.git`/`dist`）与疑似二进制文件，避免噪音与卡顿。
- [ ] 匹配过多时截断：返回总匹配数 + 前 N 条并提示用更具体的 `pattern`/`path`/`include` 缩小范围；无匹配返回明确提示。
- [ ] 非法正则返回可读错误，不崩溃。
- [ ] 工具标注为「只读」授权级别（无文件副作用），默认放行（见 US-007）。
- [ ] 代码含中文注释；Typecheck passes。

### US-023: 只读工具 —— 按文件名模式查找（glob）
**Description:** As a user, I want agent 能按文件名 glob 模式递归查找文件, so that 它能在不了解目录结构时快速找到目标文件。

**Acceptance Criteria:**
- [ ] 实现 `glob(pattern, path?)` 工具：在工作目录内按文件名 glob 模式（如 `**/*.ts`、`src/**/*.tsx`）递归查找文件，返回相对工作目录的匹配路径列表。
- [ ] `path` 可选限定搜索根（默认工作目录根 `.`），路径经 `resolveSafePath` 白名单校验，越界返回明确错误。
- [ ] 默认跳过常见噪音目录（`node_modules`/`.git`/`dist`）。
- [ ] 结果按路径排序；过多时截断（总数 + 前 N 条并提示缩小范围）；无匹配返回明确提示。
- [ ] 工具标注为「只读」授权级别（无文件副作用），默认放行（见 US-007）。
- [ ] 代码含中文注释；Typecheck passes。

## 4. Functional Requirements

- FR-1: 系统必须基于 LangGraph 的 `StateGraph` 实现 agent 主循环，包含 `agent` 与 `tools` 两个核心节点及条件边。
- FR-2: 系统必须提供工具：`read_file`、`list_dir`、`grep`、`glob`、`write_file`、`edit_file`、`run_command`。
- FR-3: 所有涉及路径的工具必须将路径限制在配置的工作目录白名单内，越界操作必须被拒绝。
- FR-4: `run_command` 必须使用 `child_process` 执行，锁定 `cwd`，并强制可配置的执行超时。
- FR-5: `edit_file` 必须基于 `old_string`/`new_string` 精确替换，`old_string` 不唯一或不存在时报错且不修改。
- FR-6: 工具结果必须做预算截断：`read_file` 支持 offset/limit 分页并标注剩余量；`run_command` 输出按字节预算保留头部+尾部、中间省略占位；预算可配置。
- FR-7: 授权必须采用 `工具名(参数模式)` 模式匹配，规则存于 `.litecode/settings.local.json` 的 `permissions.allow` / `permissions.deny`；deny 优先，allow 免询问，未命中则提示用户。
- FR-8: 授权交互必须支持「本次允许 / 本次拒绝 / 始终允许（写入 allow 规则）/ 始终拒绝（写入 deny 规则）」，并把当前调用泛化为可复用的模式规则持久化。
- FR-9: 用户拒绝某操作时，系统必须把拒绝信息作为工具结果回传给 agent，而不是终止程序。
- FR-10: 系统必须通过工厂模式支持可切换的 LLM provider，默认 **Anthropic**，默认 model `claude-sonnet-4-6`，支持 `apiKey` / `baseURL` / `model` 配置。
- FR-11: 系统必须提供基于 **Ink** 的 CLI REPL 交互界面，采用状态驱动的分步骤块状展示（非流式 token）。
- FR-12: 系统必须在等待 LLM 响应时显示思考动画（spinner + 文案 + 已用时计数 + 中断提示）。
- FR-13: 系统必须提供 `update_todos` 工具，由 agent 主动维护 todo 列表，并在 UI 中以 ○/◐/✓ 实时勾选；todo 状态纳入图状态。
- FR-14: 系统必须支持按 Esc 中断运行中的 agent：用 AbortController 贯穿主循环，取消 LLM/工具执行并杀掉运行中的子进程，中断后可继续下一轮对话。
- FR-15: 系统必须有最大迭代次数限制以防止无限工具调用循环。
- FR-16: 配置（provider、模型、工作目录、超时、白名单、结果预算、Langfuse）必须可通过配置文件 / 环境变量设置。
- FR-17: 系统必须支持可选的 Langfuse 监控；当 Langfuse 配置缺失时自动跳过且不影响运行。
- FR-18: 项目代码必须包含中文注释，关键模块（图、工具、授权、provider、UI）需有解释性说明。
- FR-19:（后续优化）系统应提供降低 token 消耗的手段：精简系统提示、可选 prompt caching、可调的工具输出预算；UI 展示裁剪不得与 token 用量混淆。
- FR-20: 系统必须提供只读搜索工具 `grep`（按正则搜索文件内容，返回 `文件:行号:行内容`）与 `glob`（按文件名模式递归查找文件）；二者均经工作目录白名单校验、默认跳过噪音目录、结果过多时截断提示，标注为只读授权级别。

## 5. Non-Goals（明确不做）

- 不用 Docker / VM / 云沙箱做隔离。隔离仅依赖**操作系统自带机制**（macOS Seatbelt / Linux bubblewrap·Landlock / Windows Job Object，见 US-016~US-020）+ 路径白名单 + 超时；强度高于纯 `child_process`，但仍不等同于容器/VM 级强隔离，不保证完全对抗恶意代码。缺少原生机制的平台会降级为 `child_process` + 路径与超时限制。
- 不做 Web UI 或图形界面，仅 CLI。
- 不做对话历史 / 会话记录的持久化数据库（仅授权选择持久化到 `.litecode/settings.local.json`，对话历史不落盘）。
- 不做用户系统、权限账户、远程部署。
- 不做代码语义索引 / 向量检索 / RAG（agent 仅靠工具实时读取文件）。
- 不追求生产级安全与性能，优先可读性与学习价值。
- 不实现自动 git 操作、PR 创建等高级工作流。

## 6. Technical Considerations

- **依赖**：`@langchain/langgraph`、`@langchain/core`、`@langchain/anthropic`（默认 provider）；CLI UI 用 `ink`、`react`、`ink-spinner`、`ink-text-input`、`@types/react`；可选 `langfuse-langchain`（监控）；运行用 `tsx`，类型检查用 `typescript`。预留 `@langchain/openai` / `@langchain/ollama` 作为后续扩展。
- **Ink UI**：渲染层从 `console.log` 改为声明式 React 组件，状态驱动；agent 的事件（思考开始/结束、工具调用、todo 更新）通过回调/事件流推给 Ink App。思考动画用 `ink-spinner`；todo 列表原地刷新。
- **中断**：`AbortController` 在 CLI 层创建，贯穿 LangGraph 主循环与各工具；Ink 用 `useInput` 监听 Esc 触发 abort，`run_command` 子进程在 abort 时被 kill。
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

> 已确认决策：支持 `edit_file`（diff 局部编辑）；授权采用 Claude Code 式 `工具名(参数模式)` 模式匹配 + allow/deny，持久化到 `.litecode/settings.local.json`；默认 Anthropic provider，默认 model `claude-sonnet-4-6`；CLI 用 **Ink** 渲染（思考动画 + todo 实时勾选 + Esc 中断），分步骤块状、非流式；todo 由 agent 主动调 `update_todos` 工具维护（不自动推断）；工具结果按预算截断（read 分页 / exec 头尾保留）；可选 Langfuse 监控。
