import { expect, test } from "vitest";
import { summarizeTool } from "./toolSummary";

// God-mode mark: ToolRow showed the raw Bash command, which was unreadable.
test("summarizes a raw Bash command from the god-mode packet", () => {
  const command = "sed -n 1,60p ui/src/screens/ChangeMap.tsx; ls ui/src/screens/*.test.* ui/src/components/*.test.* 2>/dev/null; git log --oneline -1";
  expect(summarizeTool("Bash", { command })).toBe("Read ChangeMap.tsx · list files · git log");
});

test("prefers the Bash description when the agent gave one", () => {
  expect(summarizeTool("Bash", { command: "cd ui && bun run test", description: "Run UI tests" })).toBe("Run UI tests");
});

test("summarizes common tools by file name", () => {
  expect(summarizeTool("Read", { file_path: "/w/ui/src/screens/Focus.tsx" })).toBe("Read Focus.tsx");
  expect(summarizeTool("Grep", { pattern: "ToolRow", path: "/w/ui/src" })).toBe("Search for “ToolRow” in src");
  expect(summarizeTool("Bash", { command: "cd ui && bun run test && bun run build" })).toBe("Run tests · build");
});
