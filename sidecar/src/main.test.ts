import { expect, test } from "bun:test";

// Drives the real sidecar process over stdio, like the Rust core does, with the scripted fake query.
async function run(lines: object[], untilTypes: string[], timeoutMs = 5000) {
  const proc = Bun.spawn(["bun", "run", `${import.meta.dir}/main.ts`], { stdin: "pipe", stdout: "pipe", env: { ...process.env, MR_FAKE_QUERY: "1" } });
  const out: Record<string, unknown>[] = [];
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const send = (o: object) => proc.stdin.write(JSON.stringify(o) + "\n");
  for (const l of lines) send(l);
  const deadline = Date.now() + timeoutMs;
  const want = [...untilTypes];
  while (want.length && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value);
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); out.push(m);
      if (m.type === "permission_request") send({ type: "permission_response", session: m.session, request_id: m.request_id, decision: { behavior: "allow" } });
      if (want[0] === m.type) want.shift();
    }
  }
  proc.kill();
  return out;
}

test("ping works and ready reports which claude it will drive", async () => {
  const out = await run([{ type: "ping", id: "a" }], ["ready", "pong"]);
  expect(out[0]).toMatchObject({ type: "ready" });
  expect(typeof out[0].claude).toBe("string");
  expect(out[1]).toMatchObject({ type: "pong", id: "a" });
});

test("a session starts, asks permission, gets answered, and finishes a turn", async () => {
  const out = await run([{ type: "start", session: "s1", cwd: "/tmp", prompt: "hello" }], ["ready", "session_started", "permission_request", "sdk"]);
  expect(out.map((m) => m.type)).toContain("session_started");
  expect(out.find((m) => m.type === "permission_request")).toMatchObject({ session: "s1", tool: "Bash", input: { command: "touch made-by-fake.txt" } });
});

test("follow-up messages flow into the same running session", async () => {
  const out = await run(
    [{ type: "start", session: "s2", cwd: "/tmp", prompt: "one" }, { type: "send", session: "s2", text: "two" }],
    ["ready", "session_started", "permission_request", "permission_request"],
  );
  expect(out.filter((m) => m.type === "permission_request").length).toBe(2);
  expect(out.filter((m) => m.type === "session_started").length).toBe(1);
});

test("commands for unknown sessions are rejected, not crashed on", async () => {
  const out = await run([{ type: "send", session: "nope", text: "x" }, { type: "ping", id: "still-alive" }], ["ready", "error", "pong"]);
  expect(out.find((m) => m.type === "error")).toMatchObject({ session: "nope", error: "unknown session" });
  expect(out.find((m) => m.type === "pong")).toMatchObject({ id: "still-alive" });
});

test("malformed lines don't kill the process", async () => {
  const proc = Bun.spawn(["bun", "run", `${import.meta.dir}/main.ts`], { stdin: "pipe", stdout: "pipe", env: { ...process.env, MR_FAKE_QUERY: "1" } });
  proc.stdin.write("not json\n" + JSON.stringify({ type: "ping", id: "t2" }) + "\n");
  proc.stdin.end();
  const lines = (await new Response(proc.stdout).text()).trim().split("\n").map((l) => JSON.parse(l));
  expect(lines.map((l) => l.type)).toEqual(["ready", "error", "pong"]);
});

test("a per-session env reaches the Claude Code process (workspace isolation)", async () => {
  const out = await run([{ type: "start", session: "w1", cwd: "/tmp", prompt: "hi", env: { CLAUDE_CONFIG_DIR: "/tmp/ws-a/claude" } }], ["ready", "session_started", "sdk"]);
  const init = out.find((m) => m.type === "sdk" && (m.message as { subtype?: string }).subtype === "init") as { message: { config_dir: string } };
  expect(init.message.config_dir).toBe("/tmp/ws-a/claude");
});

test("a one-shot runs one tool-less turn and returns its text, without a session", async () => {
  const out = await run([{ type: "oneshot", id: "o1", prompt: "diagram this", system: "json only" }], ["ready", "oneshot_result"]);
  expect(out.find((m) => m.type === "oneshot_result")).toMatchObject({ id: "o1", ok: true, text: "echo: diagram this" });
  expect(out.some((m) => m.type === "permission_request" || m.type === "session_started")).toBe(false);
});

test("limits are read without running a turn", async () => {
  const out = await run([{ type: "limits" }], ["ready", "limits"]);
  expect(out.find((m) => m.type === "limits")).toMatchObject({ available: true, plan: "max", five_hour: { utilization: 0.42, resetsAt: 1791576000 }, seven_day: { utilization: 0.07, resetsAt: null } });
  expect(out.some((m) => m.type === "session_started")).toBe(false);
});

test("the model list is read without running a turn, with each model's effort levels", async () => {
  const out = await run([{ type: "models" }], ["ready", "models"]);
  const m = out.find((x) => x.type === "models") as { models: { value: string; efforts: string[] }[] };
  expect(m.models.map((r) => r.value)).toEqual(["default", "haiku"]);
  expect(m.models[0].efforts).toContain("xhigh");
  expect(m.models[1].efforts).toEqual([]);
});

test("model and effort switch mid-session, and a refused switch reports why", async () => {
  const out = await run(
    [{ type: "start", session: "m1", cwd: "/tmp", prompt: "hi", model: "opus", effort: "high" }, { type: "set_model", session: "m1", model: "haiku", effort: "low" }, { type: "set_model", session: "m1", model: "broken" }],
    ["ready", "model_set", "model_set"],
  );
  const sets = out.filter((x) => x.type === "model_set");
  expect(sets[0]).toMatchObject({ session: "m1", model: "haiku", effort: "low", ok: true });
  expect(sets[1]).toMatchObject({ session: "m1", model: "broken", ok: false, error: "unknown model" });
});
