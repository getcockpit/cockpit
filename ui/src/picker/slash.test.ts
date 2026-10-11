import { describe, expect, test } from "vitest";
import { matchCommands, routeSlash, typedCommand } from "./slash";
import type { CommandRow } from "../state/types";

const row = (name: string, x: Partial<CommandRow> = {}): CommandRow => ({ name, description: "", hint: "", aliases: [], builtin: false, skill: false, terminal: false, ...x });
// Names from a real session's init (MR-87).
const ROWS = [
  row("mcp", { builtin: true, description: "Manage MCP servers" }),
  row("model", { builtin: true, description: "Set the AI model" }),
  row("compact", { builtin: true, description: "Clear history but keep a summary" }),
  row("doctor", { builtin: true, terminal: true, description: "Diagnose the install" }),
  row("usage", { builtin: true, aliases: ["cost"], description: "Plan usage" }),
  row("mr-task", { skill: true, description: "Run one Cockpit task end to end" }),
  row("agent-skills:review", { skill: true, description: "Five-axis code review" }),
  row("review", { skill: true, description: "Review a PR or branch" }),
];

describe("typedCommand", () => {
  test("only while the name is being typed", () => {
    expect(typedCommand("/")).toBe("");
    expect(typedCommand("/Mc")).toBe("mc");
    expect(typedCommand("/review 482")).toBeNull();
    expect(typedCommand("fix /mcp")).toBeNull();
  });
});

describe("matchCommands", () => {
  test("prefix matches beat contains, and a plugin skill matches on its short name", () => {
    expect(matchCommands(ROWS, "rev").map((r) => r.name)).toEqual(["review", "agent-skills:review"]);
    expect(matchCommands(ROWS, "mc")[0].name).toBe("mcp");
  });
  test("descriptions match too, and aliases count as an exact hit", () => {
    expect(matchCommands(ROWS, "summary").map((r) => r.name)).toEqual(["compact"]);
    expect(matchCommands(ROWS, "cost")[0].name).toBe("usage");
  });
  test("nothing typed lists skills first, capped", () => {
    const r = matchCommands(ROWS, "", 3);
    expect(r).toHaveLength(3);
    expect(r.every((x) => x.skill)).toBe(true);
  });
});

describe("routeSlash", () => {
  test("/mcp and /model open the app's own panels", () => {
    expect(routeSlash("/mcp", ROWS)).toEqual({ to: "native", name: "mcp" });
    expect(routeSlash(" /model ", ROWS)).toEqual({ to: "native", name: "model" });
  });
  test("/model with a value is Claude Code's to run", () => {
    expect(routeSlash("/model haiku", ROWS)).toEqual({ to: "send" });
  });
  test("skills and headless built-ins are sent", () => {
    expect(routeSlash("/mr-task MR-87", ROWS)).toEqual({ to: "send" });
    expect(routeSlash("/compact", ROWS)).toEqual({ to: "send" });
    expect(routeSlash("/cost", ROWS)).toEqual({ to: "send" });
  });
  test("terminal-only commands go to the terminal, with their arguments", () => {
    expect(routeSlash("/doctor", ROWS)).toEqual({ to: "terminal", command: "/doctor" });
    expect(routeSlash("/login", ROWS)).toEqual({ to: "terminal", command: "/login" });
    expect(routeSlash("/permissions add Bash", ROWS)).toEqual({ to: "terminal", command: "/permissions add Bash" });
  });
  test("a name this session doesn't know is flagged, not sent blind", () => {
    expect(routeSlash("/mpc", ROWS)).toEqual({ to: "unknown", name: "mpc" });
  });
  test("plain text, paths, and anything before the list is known are just sent", () => {
    expect(routeSlash("look at /usr/bin please", ROWS)).toEqual({ to: "send" });
    expect(routeSlash("/usr/bin/env is odd", ROWS)).toEqual({ to: "send" });
    expect(routeSlash("/anything", [])).toEqual({ to: "send" });
  });
  test("a user skill that happens to be called mcp is still the user's", () => {
    expect(routeSlash("/mcp", [row("mcp", { skill: true })])).toEqual({ to: "send" });
  });
});
