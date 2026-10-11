// Token diet: what the fixed prefix of a session is made of. Each variant runs one tiny turn and
// prints the input tokens of its first API call. Run: bun run spike/prefix.ts [model]  (a few cents)
import { query } from "@anthropic-ai/claude-agent-sdk";
import { resolveClaude } from "../src/claude-path";

const model = process.argv[2] ?? "haiku";
const cwd = process.cwd();
const base = { cwd, model, maxTurns: 1, persistSession: false, pathToClaudeCodeExecutable: resolveClaude(), canUseTool: async () => ({ behavior: "deny", message: "probe" }) };
const variants: [string, Record<string, unknown>][] = [
  ["baseline (as sessions run today)", { systemPrompt: { type: "preset", preset: "claude_code" } }],
  ["no claude.ai connectors", { systemPrompt: { type: "preset", preset: "claude_code" }, env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: "false" } }],
  ["no skills", { systemPrompt: { type: "preset", preset: "claude_code" }, skills: [] }],
  ["no user settings (plugins, user CLAUDE.md)", { systemPrompt: { type: "preset", preset: "claude_code" }, settingSources: ["project", "local"] }],
  ["no settings at all", { systemPrompt: { type: "preset", preset: "claude_code" }, settingSources: [] }],
  ["excludeDynamicSections", { systemPrompt: { type: "preset", preset: "claude_code", excludeDynamicSections: true } }],
];
for (const [name, opts] of variants) {
  async function* p() { yield { type: "user" as const, message: { role: "user" as const, content: "Reply with OK." }, parent_tool_use_id: null }; }
  let n = 0;
  try {
    for await (const m of query({ prompt: p(), options: { ...base, ...opts } as never })) {
      const u = (m as { type: string; message?: { usage?: Record<string, number> } }).message?.usage;
    if ((m as { type: string }).type === "assistant" && u && !n) n = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    }
  } catch { // hitting maxTurns still leaves the first call measured
  }
  console.log(`${(n / 1000).toFixed(1).padStart(6)}k  ${name}`);
}
