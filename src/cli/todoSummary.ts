/**
 * 任务清单展示摘要：把完整清单收敛为「最多展示 N 条 + 统计」。
 *
 * 选窗策略：当任务数超过 max 时，以「第一个未完成（in_progress/pending）的任务」为锚点
 * 取一个长度为 max 的窗口（再夹到边界内），保证当前正在做的任务始终可见，而不是被前面
 * 一堆已完成项挤出视野。全部已完成时则取最前面 max 条。
 */

import type { Todo } from "../tools/updateTodos.js";

/** 任务清单展示摘要 */
export interface TodoSummary {
  /** 实际展示的任务（最多 max 条） */
  visible: Todo[];
  /** 任务总数 */
  total: number;
  /** 已完成数量 */
  completed: number;
  /** 是否发生了截断（total > max） */
  truncated: boolean;
}

/**
 * 计算任务清单的展示摘要。
 * @param todos 完整任务清单
 * @param max 最多展示条数，默认 3
 */
export function summarizeTodos(todos: Todo[], max = 3): TodoSummary {
  const total = todos.length;
  const completed = todos.filter((t) => t.status === "completed").length;

  if (total <= max) {
    return { visible: todos, total, completed, truncated: false };
  }

  // 锚点：第一个未完成任务；若全部完成则从头开始
  const firstIncomplete = todos.findIndex((t) => t.status !== "completed");
  const anchor = firstIncomplete === -1 ? 0 : firstIncomplete;
  // 取以锚点开头、长度 max 的窗口，并夹到 [0, total-max]
  const start = Math.max(0, Math.min(anchor, total - max));
  const visible = todos.slice(start, start + max);

  return { visible, total, completed, truncated: true };
}
