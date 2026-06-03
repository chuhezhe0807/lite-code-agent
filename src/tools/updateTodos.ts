/**
 * update_todos 工具：让 agent 主动维护一个任务清单（参考 Claude Code 的 TodoWrite）。
 *
 * 设计要点：
 *   - agent 传入「完整」的 todo 列表（每项含内容与状态），每次调用整体覆盖，语义简单。
 *   - 工具本身无副作用（不碰文件系统），归为 read 级别 → 免授权，不打扰用户。
 *   - 真正把 todo 写入图状态、再推给 UI 渲染的逻辑在 graph 的 tools 节点里完成
 *     （工具无法直接修改图状态），本模块导出 Todo 类型与解析函数供其复用。
 */

import { z } from "zod";
import { tool } from "@langchain/core/tools";
import type { ToolSpec } from "./types.js";

/** 工具名常量，供 graph 节点识别这次调用需要更新图状态 */
export const UPDATE_TODOS_NAME = "update_todos";

/** todo 项状态 */
export type TodoStatus = "pending" | "in_progress" | "completed";

/** 单个 todo 项 */
export interface Todo {
  content: string;
  status: TodoStatus;
}

const todoSchema = z.object({
  content: z.string().describe("任务内容（简短一句）"),
  status: z
    .enum(["pending", "in_progress", "completed"])
    .describe("状态：pending 待办 / in_progress 进行中 / completed 已完成"),
});

const schema = z.object({
  todos: z.array(todoSchema).describe("完整的任务清单（整体覆盖之前的清单）"),
});

/**
 * 从工具调用参数中解析出 Todo 列表（容错：过滤非法项）。
 * 供 graph 的 tools 节点把 todo 写入图状态时复用。
 */
export function parseTodos(args: Record<string, unknown>): Todo[] {
  const raw = (args as { todos?: unknown }).todos;
  if (!Array.isArray(raw)) return [];
  const valid: TodoStatus[] = ["pending", "in_progress", "completed"];
  return raw
    .filter(
      (t): t is Todo =>
        typeof t === "object" &&
        t !== null &&
        typeof (t as Todo).content === "string" &&
        valid.includes((t as Todo).status),
    )
    .map((t) => ({ content: t.content, status: t.status }));
}

/**
 * 创建 update_todos 工具。
 */
export function createUpdateTodosTool(): ToolSpec {
  const updateTodosTool = tool(
    async (input): Promise<string> => {
      const todos = parseTodos(input as Record<string, unknown>);
      const done = todos.filter((t) => t.status === "completed").length;
      const doing = todos.filter((t) => t.status === "in_progress").length;
      const pending = todos.filter((t) => t.status === "pending").length;
      return `已更新任务清单（共 ${todos.length} 项：完成 ${done} / 进行中 ${doing} / 待办 ${pending}）。`;
    },
    {
      name: UPDATE_TODOS_NAME,
      description:
        "维护任务清单：传入完整的 todo 列表（每项含 content 与 status）。在开始多步任务时用它列出计划，并随进展更新各项状态。",
      schema,
    },
  );

  // 无文件系统副作用，归为 read 级别（免授权）
  return { tool: updateTodosTool, level: "read" };
}
