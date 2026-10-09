// The SDK sidecar: the only process that talks to Claude Code.
// Protocol: one JSON object per line on stdin (from the Rust core) and stdout (to it).
// MR-1 only proves the pipe works; MR-2 adds the Agent SDK.

type Inbound = { type: "ping"; id?: string } | { type: string; [k: string]: unknown };

const VERSION = "0.1.0";

function emit(message: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function handle(message: Inbound): void {
  switch (message.type) {
    case "ping":
      emit({ type: "pong", id: message.id ?? null, at: Date.now() });
      return;
    default:
      emit({ type: "error", error: `unknown message type: ${message.type}` });
  }
}

emit({ type: "ready", version: VERSION, runtime: `bun ${Bun.version}` });

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let i: number;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line) as Inbound);
    } catch {
      emit({ type: "error", error: "invalid JSON line" });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
