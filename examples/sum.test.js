// 极简测试：不依赖任何测试框架，断言失败则非零退出。
// 用于演示 agent 通过 run_command 执行 `npm test`。
const assert = require("node:assert");
const { sum } = require("./sum");

assert.strictEqual(sum([1, 2, 3]), 6, "sum([1,2,3]) 应为 6");
assert.strictEqual(sum([]), 0, "sum([]) 应为 0");
assert.strictEqual(sum([-1, 1]), 0, "sum([-1,1]) 应为 0");

console.log("所有测试通过 ✓");
