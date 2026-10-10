// The SDK sidecar: the only process that talks to Claude Code.
// Protocol (see protocol.ts): one JSON object per line on stdin (from the Rust core) and stdout (to it).
import { query } from "@anthropic-ai/claude-agent-sdk";
import { resolveClaude } from "./claude-path";
import { relayMcp } from "./mcp";
import { oneshot } from "./oneshot";
import { limits, models } from "./limits";
import type { Inbound, Outbound } from "./protocol";
import { Sessions, type QueryFn } from "./sessions";

const VERSION = "0.2.0";

function emit(message: Outbound): void {
  process.stdout.write(JSON.stringify(message) + "\n");
}

const claudePath = resolveClaude();
// MR_FAKE_QUERY lets tests drive the full process without spending usage.
const queryFn: QueryFn = process.env.MR_FAKE_QUERY
  ? (await import("./fake-query")).fakeQuery
  : (query as unknown as QueryFn);
const sessions = new Sessions(emit, queryFn, claudePath, relayMcp);

function handle(message: Inbound): void {
  if (message.type === "ping") return emit({ type: "pong", id: message.id ?? null, at: Date.now() });
  if (message.type === "limits") return void limits(queryFn, claudePath ?? undefined, message.env, emit);
  if (message.type === "models") return void models(queryFn, claudePath ?? undefined, message.env, emit);
  if (message.type === "oneshot") return void oneshot(queryFn, claudePath ?? undefined, message, emit);
  if (["start", "send", "interrupt", "set_model", "stop", "permission_response", "tool_result"].includes(message.type)) return sessions.handle(message);
  emit({ type: "error", error: `unknown message type: ${(message as { type: string }).type}` });
}

emit({ type: "ready", version: VERSION, runtime: `bun ${Bun.version}`, claude: claudePath ?? "bundled" });

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let i: number;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    let parsed: Inbound;
    try { parsed = JSON.parse(line) as Inbound; } catch { emit({ type: "error", error: "invalid JSON line" }); continue; }
    handle(parsed);
  }
});
process.stdin.on("end", () => process.exit(0));
