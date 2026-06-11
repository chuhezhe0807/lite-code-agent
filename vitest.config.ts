import { defineConfig } from "vitest/config";

/**
 * vitest 配置（US-025）
 * 仅运行 test/ 下的单元测试，排除 examples/（那是给 agent 演示用的独立项目，
 * 其 *.test.js 用的是自带断言、并非 vitest 用例）。
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
