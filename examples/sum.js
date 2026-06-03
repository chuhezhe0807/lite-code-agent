// 一个最小示例模块：把数组求和。
// 可以让 agent 读它、改它（比如加一个 average 函数），再运行 `npm test` 验证。
function sum(numbers) {
  return numbers.reduce((acc, n) => acc + n, 0);
}

module.exports = { sum };
