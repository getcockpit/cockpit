// MR-2 spike: run one real session through the official Agent SDK under the user's own
// Claude login and record every message, permission request and MCP call as fixtures.
// Run: bun run spike/probe.ts   (uses a few cents of subscription usage)
import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

const out = join(import.meta.dir, "..", "fixtures");
mkdirSync(out, { recursive: true });
const cwd = mkdtempSync(join(tmpdir(), "mr-probe-"));
writeFileSync(join(cwd, "hello.txt"), "hi\n");

const messages: unknown[] = [];
const permissions: unknown[] = [];
const mcpCalls: unknown[] = [];

// The app-owned doc tools (decision 12), here as a stub that records its input.
const docs = createSdkMcpServer({
  name: "mr",
  version: "0.1.0",
  tools: [
    tool("doc_read", "Read a working document block by id", { block_id: z.string() }, async (args) => {
      mcpCalls.push({ tool: "doc_read", args });
      return { content: [{ type: "text", text: `Block ${args.block_id}: Every payment event lands exactly once.` }] };
    }),
  ],
});

let systemClaude: string | undefined;
try { systemClaude = execSync("command -v claude").toString().trim() || undefined; } catch { /* use bundled */ }

const q = query({
  prompt:
    "Do these three things in order, briefly: 1) run `ls` with the Bash tool; 2) use the AskUserQuestion tool to ask me to choose between 'red' and 'blue'; 3) call the mcp__mr__doc_read tool with block_id 'goal'. Then reply with one line summarising what you got.",
  options: {
    cwd,
    pathToClaudeCodeExecutable: systemClaude,
    mcpServers: { mr: docs },
    maxTurns: 8,
    settingSources: [],
    canUseTool: async (toolName, input, opts) => {
      permissions.push({ toolName, input, suggestions: opts.suggestions ?? null, decisionReason: opts.decisionReason ?? null, mcpServer: opts.mcpServer ?? null });
      if (toolName === "AskUserQuestion") {
        const qs = (input as { questions: { question: string }[] }).questions;
        return { behavior: "allow", updatedInput: { ...input, answers: Object.fromEntries(qs.map((x) => [x.question, "blue"])) } };
      }
      return { behavior: "allow", updatedInput: input };
    },
  },
});

const started = Date.now();
for await (const m of q) messages.push(m);

writeFileSync(join(out, "probe.messages.jsonl"), messages.map((m) => JSON.stringify(m)).join("\n") + "\n");
writeFileSync(join(out, "probe.permissions.json"), JSON.stringify(permissions, null, 2) + "\n");
writeFileSync(join(out, "probe.mcp.json"), JSON.stringify(mcpCalls, null, 2) + "\n");

const types = messages.map((m) => { const x = m as { type: string; subtype?: string }; return x.subtype ? `${x.type}/${x.subtype}` : x.type; });
const init = messages.find((m) => (m as { type: string; subtype?: string }).type === "system" && (m as { subtype?: string }).subtype === "init") as Record<string, unknown> | undefined;
const result = messages.find((m) => (m as { type: string }).type === "result") as Record<string, unknown> | undefined;
console.log(JSON.stringify({
  executable: systemClaude ?? "bundled",
  seconds: Math.round((Date.now() - started) / 1000),
  messageTypes: [...new Set(types)],
  count: messages.length,
  apiKeySource: init?.apiKeySource, model: init?.model, permissionMode: init?.permissionMode,
  permissionsAsked: permissions.map((p) => (p as { toolName: string }).toolName),
  mcpCalls: mcpCalls.length,
  result: result ? { subtype: result.subtype, is_error: result.is_error, text: result.result, cost: result.total_cost_usd } : null,
}, null, 2));
