import { expect, test } from "vitest";
import type { Todo } from "../state/types";
import { liveCaption } from "./Now";

// God-mode mark: a working tile read "40% · Thinking" with no hint of which plan step it was on.
test("a working wall tile names the current plan step instead of the activity label", () => {
  const todos: Todo[] = [
    { content: "Find the design components", status: "completed" },
    { content: "Map them to the catalog", status: "completed" },
    { content: "Wire the change graph", status: "in_progress", activeForm: "Wiring the change graph" },
    { content: "Test", status: "pending" },
    { content: "Commit", status: "pending" },
  ];
  expect(liveCaption(todos, "Thinking", true)).toBe("40% · Wiring the change graph");
  // No step marked in progress while working: the next one to do is current.
  expect(liveCaption(todos.map((t, i) => (i === 2 ? { ...t, status: "pending" } : t)), "Thinking", true)).toBe("40% · Wiring the change graph");
  // Focus (not compact) keeps the step count and the live activity.
  expect(liveCaption(todos, "Thinking")).toBe("40% · step 3 of 5 · Thinking");
  // No plan: the activity label is all there is.
  expect(liveCaption([], "Thinking", true)).toBe("Thinking");
});
