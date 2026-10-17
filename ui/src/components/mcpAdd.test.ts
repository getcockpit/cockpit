import { describe, expect, it } from "vitest";
import { buildConfig, parsePairs, splitCommand } from "./mcpAdd";

describe("adding an MCP server from /mcp", () => {
  it("splits a command line like a shell", () => {
    expect(splitCommand(`npx -y @scope/server "~/My Code" 'a b' c\\ d ""`)).toEqual(["npx", "-y", "@scope/server", "~/My Code", "a b", "c d", ""]);
    expect(splitCommand("  ")).toEqual([]);
  });
  it("reads env and header lines, and says which line is wrong", () => {
    expect(parsePairs("A=1\n\n B = x=y ", "=")).toEqual({ A: "1", B: "x=y" });
    expect(parsePairs("Authorization: Bearer t:1", ":")).toEqual({ Authorization: "Bearer t:1" });
    expect(parsePairs("oops", "=")).toBe(`"oops" isn't KEY=value`);
  });
  it("builds what claude mcp add-json takes", () => {
    expect(buildConfig({ name: "fs", transport: "stdio", target: "npx -y fs ~/code", pairs: "DEBUG=1" })).toEqual({ type: "stdio", command: "npx", args: ["-y", "fs", "~/code"], env: { DEBUG: "1" } });
    expect(buildConfig({ name: "web", transport: "http", target: " https://x.dev/mcp ", pairs: "" })).toEqual({ type: "http", url: "https://x.dev/mcp" });
    expect(buildConfig({ name: "web", transport: "sse", target: "https://x.dev/sse", pairs: "X-Key: 1" })).toEqual({ type: "sse", url: "https://x.dev/sse", headers: { "X-Key": "1" } });
  });
  it("names what's missing instead of sending it", () => {
    expect(buildConfig({ name: "a b", transport: "http", target: "https://x", pairs: "" })).toMatch(/^Name/);
    expect(buildConfig({ name: "mr", transport: "http", target: "https://x", pairs: "" })).toMatch(/Cockpit/);
    expect(buildConfig({ name: "web", transport: "http", target: "x.dev", pairs: "" })).toMatch(/^URL/);
    expect(buildConfig({ name: "fs", transport: "stdio", target: "", pairs: "" })).toMatch(/^Command/);
  });
});
