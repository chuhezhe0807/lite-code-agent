import { describe, it, expect } from "vitest";
import { summarizeTodos } from "../src/cli/todoSummary.js";
import type { Todo } from "../src/tools/updateTodos.js";

const t = (content: string, status: Todo["status"]): Todo => ({ content, status });

describe("summarizeTodos", () => {
  it("不超过上限时全部展示，不截断", () => {
    const todos = [t("a", "completed"), t("b", "in_progress"), t("c", "pending")];
    const r = summarizeTodos(todos, 3);
    expect(r.truncated).toBe(false);
    expect(r.visible).toHaveLength(3);
    expect(r.total).toBe(3);
    expect(r.completed).toBe(1);
  });

  it("超出上限时截断并统计总数/已完成数", () => {
    const todos = [
      t("a", "completed"),
      t("b", "completed"),
      t("c", "in_progress"),
      t("d", "pending"),
      t("e", "pending"),
    ];
    const r = summarizeTodos(todos, 3);
    expect(r.truncated).toBe(true);
    expect(r.visible).toHaveLength(3);
    expect(r.total).toBe(5);
    expect(r.completed).toBe(2);
  });

  it("窗口以第一个未完成任务为锚点，保证进行中的任务可见", () => {
    const todos = [
      t("a", "completed"),
      t("b", "completed"),
      t("c", "completed"),
      t("d", "in_progress"),
      t("e", "pending"),
    ];
    const r = summarizeTodos(todos, 3);
    // 第一个未完成是 d（index 3），窗口夹到 [2,5) → c,d,e
    expect(r.visible.map((x) => x.content)).toEqual(["c", "d", "e"]);
  });

  it("锚点靠前时窗口从锚点开始", () => {
    const todos = [
      t("a", "in_progress"),
      t("b", "pending"),
      t("c", "pending"),
      t("d", "pending"),
    ];
    const r = summarizeTodos(todos, 3);
    expect(r.visible.map((x) => x.content)).toEqual(["a", "b", "c"]);
  });

  it("全部完成且超出上限时取最前面 max 条", () => {
    const todos = [
      t("a", "completed"),
      t("b", "completed"),
      t("c", "completed"),
      t("d", "completed"),
    ];
    const r = summarizeTodos(todos, 3);
    expect(r.truncated).toBe(true);
    expect(r.completed).toBe(4);
    expect(r.visible.map((x) => x.content)).toEqual(["a", "b", "c"]);
  });

  it("空清单", () => {
    const r = summarizeTodos([], 3);
    expect(r).toEqual({ visible: [], total: 0, completed: 0, truncated: false });
  });

  it("默认上限为 3", () => {
    const todos = Array.from({ length: 6 }, (_, i) => t(`x${i}`, "pending"));
    expect(summarizeTodos(todos).visible).toHaveLength(3);
  });
});
