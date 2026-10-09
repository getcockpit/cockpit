// Live contract check (spends a little subscription usage): drives the compiled sidecar logic
// against the real claude through the same NDJSON protocol the Rust core uses.
// Run: bun run spike/live-session.ts
const proc = Bun.spawn(process.env.MR_SIDECAR_BIN ? [process.env.MR_SIDECAR_BIN] : ["bun", "run", `${import.meta.dir}/../src/main.ts`], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
const send = (o: object) => proc.stdin.write(JSON.stringify(o) + "\n");
const seen: string[] = [];
const tools = [{ name: "doc_read", description: "Read a block of the current working document by its id. Use it whenever asked about the doc.", params: { block_id: "string" } }];

send({ type: "start", session: "live1", cwd: "/tmp", prompt: "Call the mcp__mr__doc_read tool with block_id 'goal', then answer in one line with what it says.", tools });

const reader = proc.stdout.getReader();
const dec = new TextDecoder();
let buf = "";
const deadline = Date.now() + 120_000;
let result: unknown = null;
outer: while (Date.now() < deadline) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += dec.decode(value);
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    const tag = m.type === "sdk" ? `sdk:${m.message.type}${m.message.subtype ? "/" + m.message.subtype : ""}` : m.type;
    if (!seen.includes(tag)) seen.push(tag);
    if (m.type === "permission_request") send({ type: "permission_response", session: m.session, request_id: m.request_id, decision: { behavior: "allow" } });
    if (m.type === "tool_call") send({ type: "tool_result", session: m.session, call_id: m.call_id, text: "Goal: every payment event lands exactly once." });
    if (m.type === "sdk" && m.message.type === "result") { result = m.message.result; send({ type: "stop", session: "live1" }); }
    if (m.type === "session_ended") break outer;
  }
}
proc.kill();
console.log(JSON.stringify({ seen, result }, null, 2));
