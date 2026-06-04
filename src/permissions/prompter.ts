/**
 * 授权交互的「提问者」抽象
 *
 * 授权逻辑（manager.ts）需要在未命中规则时「问用户」，但提问的具体方式取决于界面。
 * 通过这个接口把「决策逻辑」与「界面交互」解耦：manager 只依赖接口，具体实现由界面层注入。
 * 当前实现是 Ink 版的 SessionController（src/cli/controller.ts），用键盘方向键选择，
 * 通过事件桥把用户选择 resolve 回这里。
 */

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
