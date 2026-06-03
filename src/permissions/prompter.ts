/**
 * 授权交互的「提问者」抽象
 *
 * 授权逻辑（manager.ts）需要在未命中规则时「问用户」，但提问的具体方式取决于界面：
 *   - 本故事（US-007）提供基于 Node readline 的默认实现，先把授权链路跑通。
 *   - 后续 US-009 用 Ink 重构 CLI 时，会实现一个 Ink 版 AuthPrompter 注入进来，
 *     替换掉 readline 版本，而 manager 的授权逻辑无需改动。
 *
 * 通过这个接口把「决策逻辑」与「界面交互」解耦，是依赖注入的典型用法。
 */

import { createInterface } from "node:readline/promises";

/** 用户对一次授权请求的选择 */
export type AuthChoice = "y" | "n" | "a" | "d";

/** 授权提问者接口 */
export interface AuthPrompter {
  /**
   * 展示操作详情并询问用户决定。
   * @param detail 操作详情（来自工具的 preview，或回退描述）
   * @returns y=本次允许 / n=本次拒绝 / a=始终允许 / d=始终拒绝
   */
  askDecision(detail: string): Promise<AuthChoice>;

  /**
   * 在把泛化规则写入 settings 前，向用户确认规则文本。
   * @param ruleText 生成的规则字符串，如 "run_command(npx tsc *)"
   * @returns true=确认写入 / false=不写入（本次仍按 a/d 的方向处理一次）
   */
  confirmRule(ruleText: string): Promise<boolean>;
}

/**
 * 创建基于 readline 的默认提问者（终端 stdin/stdout 交互）。
 */
export function createReadlinePrompter(): AuthPrompter {
  /** 读一行输入并去空白小写 */
  async function ask(question: string): Promise<string> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rl.question(question);
      return answer.trim().toLowerCase();
    } finally {
      rl.close();
    }
  }

  return {
    async askDecision(detail: string): Promise<AuthChoice> {
      console.log("\n需要授权：");
      console.log(detail);
      // 循环直到拿到合法选择
      for (;;) {
        const ans = await ask(
          "允许执行？ [y]本次允许 / [n]本次拒绝 / [a]始终允许 / [d]始终拒绝： ",
        );
        if (ans === "y" || ans === "n" || ans === "a" || ans === "d") {
          return ans;
        }
        console.log("请输入 y / n / a / d 之一。");
      }
    },

    async confirmRule(ruleText: string): Promise<boolean> {
      const ans = await ask(`将记住规则：${ruleText}\n确认写入设置？ [y/n]： `);
      return ans === "y" || ans === "yes";
    },
  };
}
