# Lite Code Agent

一个用于**学习 Agent 应用开发**的轻量级 code agent，参考 Claude Code 的核心交互模式，
用 **LangGraph + TypeScript** 实现。它在终端里与你对话，能读写本地文件、在受限沙箱中
执行命令和构建脚本，所有敏感操作都经过分级授权。

> ⚠️ **学习级隔离**：沙箱仅靠 `child_process` + 工作目录白名单 + 超时实现，**不保证**对抗
> 恶意代码。请勿在其中运行不可信的命令或代码。

## 特性

- 🔁 **LangGraph 主循环**：`StateGraph` 编排「思考 → 调用工具 → 观察 → 继续」的 ReAct 循环。
- 🧰 **工具集**：`read_file`（分页）、`list_dir`、`write_file`、`edit_file`（diff 局部编辑）、
  `run_command`（沙箱执行）、`update_todos`（任务清单）。
- 🔐 **分级授权 + 持久化**：read 免询问；write/execute 需授权；规则按 `工具名(参数模式)` 匹配，
  支持「始终允许/拒绝」并写入 `.litecode/settings.local.json`（参考 Claude Code）。
- 🖥️ **Ink 终端 UI**：块状渲染、思考动画、todo 实时勾选、方向键选择授权、`Esc` 中断。
- 🧱 **受限沙箱**：命令锁定工作目录、超时强杀、可被 `Esc` 中断（`AbortSignal` 贯穿）。
- 🔌 **可切换 Provider**：默认 Anthropic（支持 `apiKey` / `authToken` Bearer / `baseURL` / `model`），
  预留 OpenAI / Ollama 扩展点。
- 📊 **可选 Langfuse 监控**：配置即开，不配置不影响运行。

## 安装

需要 Node ≥ 18。

```bash
pnpm install
```

## 配置

凭证与运行参数从 **环境变量 / `.env`** 与 **`config.json`** 合并加载（优先级：环境变量 > config.json > 默认值）。

复制 `.env.example` 为 `.env`，填入凭证（二选一）：

```bash
# 方式一：官方 Anthropic，x-api-key
ANTHROPIC_API_KEY=sk-ant-xxxx
# 方式二：代理/网关（如 LiteLLM）或 Claude Code 习惯的 Bearer 方式
ANTHROPIC_AUTH_TOKEN=sk-xxxx
ANTHROPIC_BASE_URL=https://your-proxy/      # 可选，自定义网关
# LLM_MODEL=claude-sonnet-4-6               # 可选
# WORKDIR=./examples                        # 可选，agent 可操作的目录
```

结构化参数放 `config.json`（见 `config.example.json`）：

| 字段 | 说明 | 默认 |
|---|---|---|
| `workdir` | agent 可操作的目录（所有文件/命令限制在此） | 当前目录 |
| `commandTimeoutMs` | 命令执行超时（毫秒） | 30000 |
| `readFileMaxLines` | `read_file` 默认读取行数上限 | 2000 |
| `commandOutputMaxBytes` | `run_command` 输出字节预算 | 30720 |
| `maxIterations` | 主循环最大迭代次数 | 25 |

## 运行

```bash
pnpm start            # = tsx src/index.ts
pnpm typecheck        # tsc --noEmit
```

启动后进入 REPL：输入任务即可，`/exit` 退出。建议先把 `WORKDIR` 指到 `examples/` 练手：

```bash
WORKDIR=./examples pnpm start
```

## 架构

```
                  ┌──────────────────────── CLI (Ink) ────────────────────────┐
                  │  app.tsx  ←(events)── SessionController ──(submit)──► graph │
                  │   ▲ blocks / todos / auth / thinking      │                │
                  └───┼───────────────────────────────────────┼────────────────┘
                      │ 用户输入 / Esc / 方向键                 │ stream(updates)
                      │                                        ▼
                                              ┌──────────  StateGraph  ──────────┐
                                              │  agent 节点 ⇄ tools 节点（条件边） │
                                              └───────────────┬───────────────────┘
                                                              │ 执行前授权拦截
                                          ┌───────────────────┼───────────────────┐
                                          │ PermissionManager  │  5+1 个工具        │
                                          │ (allow/deny 匹配)   │  read/write/exec   │
                                          └────────┬───────────┴─────────┬──────────┘
                                          .litecode/settings.local.json   沙箱 (child_process)
```

**主循环**（`src/agent/graph.ts`）：状态含 `messages`（累积）、`iterations`（迭代保护）、
`todos`。`agent` 节点调用 LLM；若产生 `tool_calls` 则进 `tools` 节点，否则结束。`tools` 节点
对每个调用先过授权再执行，结果以 `ToolMessage` 回传，然后回到 `agent` 成环。

**授权**（`src/permissions/`）：`read` 默认放行；`write`/`execute` 先匹配规则
（`deny` 优先 → `allow` 免询问 → 都不命中则提示）。提示用方向键在
本次允许 / 本次拒绝 / 始终允许 / 始终拒绝 间选择，「始终」会把本次调用泛化成规则
（如 `run_command(npx tsc *)`）写入 `.litecode/settings.local.json`。

**沙箱**（`src/sandbox/exec.ts`）：`spawn(shell)` 锁定 `cwd`，超时 `SIGKILL`，
支持外部 `AbortSignal`（`Esc` 中断时杀子进程）。

**UI 桥接**（`src/cli/controller.ts`）：`SessionController` 既是 `AuthPrompter`
（用 promise-bridge 把授权请求推给 UI 等按键），又用 `graph.stream` 把每步转成渲染块事件，
并跨轮累积对话历史。

## 工具一览

| 工具 | 级别 | 说明 |
|---|---|---|
| `read_file(path, offset?, limit?)` | read | 读取文件，分页，截断标注剩余 |
| `list_dir(path?)` | read | 列目录，目录排前，超量截断 |
| `write_file(path, content)` | write | 创建/覆盖文件，授权前展示摘要 |
| `edit_file(path, old, new)` | write | 精确替换（`old` 须唯一），授权前展示 diff |
| `run_command(command)` | execute | 沙箱执行，超时/中断保护，头尾截断输出 |
| `update_todos(todos)` | read | 维护任务清单，UI 实时 ○/◐/✓ |

## 可选：Langfuse 监控

仓库内 `docker-compose.yml` 可一键自托管 Langfuse：

```bash
docker compose up -d            # 首次较慢，等各服务 healthy
# 浏览器打开 http://localhost:3000 注册 → 建项目 → 拿 public/secret key
```

把 key 填进 `.env`：

```bash
LANGFUSE_PUBLIC_KEY=pk-lf-xxxx
LANGFUSE_SECRET_KEY=sk-lf-xxxx
LANGFUSE_BASE_URL=http://localhost:3000
```

启动后每轮对话的 LLM 调用与工具执行链路会上报到 Langfuse。**不配置则自动关闭，不影响运行。**

## 目录结构

```
src/
  index.ts              入口：装配配置/模型/工具/控制器并启动 CLI
  config.ts             配置加载与校验
  provider.ts           LLM provider 工厂（默认 Anthropic）
  agent/graph.ts        LangGraph 主循环（agent/tools 节点 + 状态）
  tools/                read_file / list_dir / write_file / edit_file / run_command / update_todos
  permissions/          授权：settings 读写 / 规则匹配 / prompter / manager
  sandbox/exec.ts       child_process 沙箱执行（超时 + 中断）
  security/path.ts      工作目录路径白名单校验
  util/                 diff 格式化 / 输出头尾截断
  observability/langfuse.ts  可选 Langfuse 回调
  cli/                  Ink UI：app / controller / thinking / types
examples/               示例工作目录（练手）
docker-compose.yml      本地自托管 Langfuse
```

## 学习要点

- LangGraph `StateGraph` 的状态/节点/条件边如何拼出 ReAct 循环。
- 工具调用循环 + human-in-the-loop 授权如何在 `tools` 节点内拦截。
- 用依赖注入（`AuthPrompter` 接口）把授权逻辑与界面解耦。
- `AbortSignal` 如何贯穿 图 → 工具 → 子进程实现中断。
- Ink/React 状态驱动渲染与命令式 agent 事件流如何通过 EventEmitter 桥接。
