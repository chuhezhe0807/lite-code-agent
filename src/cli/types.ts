/**
 * CLI 渲染相关的共享类型
 *
 * SessionController 产出这些「块」与「授权请求」，Ink App 据此渲染。
 * 把类型集中在这里，避免 controller 与 app 互相依赖实现细节。
 */

/** 一个可渲染的内容块 */
export interface Block {
  /**
   * 块类型：
   * - user        用户输入
   * - ai          模型的文本回复
   * - tool-call   模型发起的工具调用（名称 + 参数）
   * - tool-result 工具执行结果
   * - info        提示信息
   * - error       错误信息
   */
  kind: "user" | "ai" | "tool-call" | "tool-result" | "info" | "error";
  /** 正文文本 */
  text: string;
  /** 工具名（tool-call / tool-result 时有值） */
  toolName?: string;
}

/** 一次需要用户按键回答的授权/确认请求 */
export interface AuthRequest {
  /** 展示给用户的操作详情 */
  detail: string;
  /**
   * 提问模式：
   * - decision 选择 y/n/a/d
   * - confirm  确认 y/n（用于「是否写入泛化规则」）
   */
  mode: "decision" | "confirm";
  /** UI 收到按键后调用它把结果回传给等待中的授权流程 */
  resolve: (value: string) => void;
}

/** 会话阶段 */
export type Phase = "idle" | "running" | "auth";
