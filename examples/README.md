# 示例工作目录

这是给 **lite-code-agent** 练手的示例项目。把 agent 的工作目录（`WORKDIR`）指向这里，
就能在一个隔离的小项目上安全演示它的能力，而不会动到主仓库。

## 内容

- `sum.js` —— 一个把数组求和的小模块。
- `sum.test.js` —— 不依赖测试框架的断言脚本。
- `package.json` —— 提供 `npm test` 脚本。

## 可以让 agent 试的任务

- 「读一下 sum.js，告诉我它做了什么」（演示 `read_file`）
- 「给 sum.js 加一个 average(numbers) 函数并导出」（演示 `edit_file`，需授权）
- 「运行 npm test 看看通不通过」（演示 `run_command`，需授权）
- 「新建一个 max.js，实现求最大值」（演示 `write_file`，需授权）

## 用法

在项目根目录把 `WORKDIR` 指向本目录后启动：

```bash
WORKDIR=./examples pnpm start
```
