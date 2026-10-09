import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { replay } from "./reduce";
import { pickDecision, pickTile, bashRisk } from "../picker/pick";
import type { MrEvent } from "./types";

// Builds the event-log rows the Rust core would have stored for the real MR-2 probe session.
function probeEvents(): MrEvent[] {
  const raw = readFileSync(join(__dirname, "../../../sidecar/fixtures/probe.messages.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  let n = 0;
  const ev = (kind: string, payload: Record<string, unknown>, session: string | null = "s1"): MrEvent => ({ id: `E${String(++n).padStart(4, "0")}`, session_id: session, kind, payload, anchor: null, created_at: 1_000_000 + n * 1000 });
  const out: MrEvent[] = [ev("sidecar.ready", { claude: "/x/claude" }, null), ev("ui.session_requested", { prompt: "probe", cwd: "/tmp/p" })];
  for (const m of raw) {
    if (m.type === "system" && m.subtype === "init") out.push(ev("sidecar.session_started", { sdk_session_id: m.session_id, model: m.model }));
    out.push(ev("sidecar.sdk", { message: m }));
  }
  return out;
}

describe("replaying the real probe session", () => {
  const state = replay(probeEvents());
  const s = state.sessions.s1;

  test("rebuilds the session from the log", () => {
    expect(state.sidecar).toEqual({ up: true, claude: "/x/claude" });
    expect(state.order).toEqual(["s1"]);
    expect(s.title).toBe("probe");
    expect(s.model).toBe("claude-opus-5-5");
    expect(s.sdkSessionId).toBeTruthy();
  });

  test("captures tool calls with their structured results, and the final result", () => {
    const tools = s.transcript.filter((t) => t.kind === "tool").map((t) => (t.kind === "tool" ? t.name : ""));
    expect(tools).toEqual(["Bash", "AskUserQuestion", "ToolSearch", "mcp__mr__doc_read"]);
    const bash = s.transcript.find((t) => t.kind === "tool" && t.name === "Bash");
    expect(bash && bash.kind === "tool" ? (bash.result as { stdout: string }).stdout : "").toContain("hello.txt");
    const result = s.transcript.at(-1);
    expect(result?.kind).toBe("result");
    expect(s.status).toBe("idle");
    expect(s.costUsd).toBeGreaterThan(0);
  });

  test("reads usage from rate_limit_event", () => {
    expect(state.usage.fiveHour).toBeCloseTo(0.49);
  });
});

describe("permissions and questions", () => {
  const base: MrEvent[] = [{ id: "A1", session_id: "s", kind: "ui.session_requested", payload: { prompt: "p", cwd: "/w" }, anchor: null, created_at: 1 }];
  const perm = (id: string, tool: string, input: Record<string, unknown>): MrEvent => ({ id, session_id: "s", kind: "sidecar.permission_request", payload: { request_id: id, tool, input }, anchor: null, created_at: 2 });

  test("a permission request puts the session in needs-you, and answering clears it", () => {
    const st = replay([...base, perm("p1", "Bash", { command: "pnpm prisma migrate deploy" })]);
    expect(st.sessions.s.status).toBe("needs_you");
    const { spec } = pickDecision(st.sessions.s.pending[0]);
    expect(spec).toMatchObject({ component: "CommandCard", risk: "high" });
    const after = replay([...base, perm("p1", "Bash", { command: "ls" }), { id: "A3", session_id: "s", kind: "ui.permission_answered", payload: { request_id: "p1" }, anchor: null, created_at: 3 }]);
    expect(after.sessions.s.pending).toEqual([]);
    expect(after.sessions.s.status).toBe("working");
  });

  test("AskUserQuestion becomes a QuestionCard", () => {
    const q = { questions: [{ question: "Red or blue?", header: "Color", options: [{ label: "red", description: "" }, { label: "blue", description: "" }] }] };
    const st = replay([...base, perm("p2", "AskUserQuestion", q)]);
    expect(pickDecision(st.sessions.s.pending[0]).spec).toMatchObject({ component: "QuestionCard" });
    expect(pickTile(st.sessions.s).doing).toBe("Asks: Red or blue?");
  });

  test("edits become DiffCards and are tracked as file changes", () => {
    const st = replay([...base, perm("p3", "Edit", { file_path: "/w/a.ts", old_string: "a\nb", new_string: "a\nb\nc" })]);
    expect(pickDecision(st.sessions.s.pending[0]).spec).toMatchObject({ component: "DiffCard", path: "/w/a.ts", added: 3, removed: 2 });
  });

  test("layer 1 is fast", () => {
    const st = replay([...base, perm("p4", "Bash", { command: "ls -la" })]);
    expect(pickDecision(st.sessions.s.pending[0]).record.ms).toBeLessThan(16);
  });
});

test("risk heuristics", () => {
  expect(bashRisk("ls -la").risk).toBe("low");
  expect(bashRisk("git push origin main").risk).toBe("medium");
  expect(bashRisk("rm -rf dist").risk).toBe("high");
  expect(bashRisk("terraform apply").risk).toBe("high");
});

test("sessions running when the sidecar restarts become interrupted, and resume restarts them", () => {
  const ev = (id: string, kind: string, payload: Record<string, unknown>, session: string | null = "s"): MrEvent => ({ id, session_id: session, kind, payload, anchor: null, created_at: 1 });
  const before = replay([
    ev("A1", "sidecar.ready", {}, null),
    ev("A2", "ui.session_requested", { prompt: "p", cwd: "/w/repo-worktrees/x", kind: "blank", branch: "mr/x-ab12", repo: "/w/repo" }),
    ev("A3", "sidecar.session_started", { sdk_session_id: "sdk-1" }),
  ]);
  expect(before.sessions.s.branch).toBe("mr/x-ab12");
  const after = replay([ev("A4", "sidecar.ready", {}, null)], before);
  expect(after.sessions.s.status).toBe("interrupted");
  expect(pickTile(after.sessions.s).state).toBe("interrupted");
  const resumed = replay([ev("A5", "ui.session_requested", { prompt: "Continue", cwd: "/w/repo-worktrees/x", kind: "blank", resume: "sdk-1" })], after);
  expect(resumed.sessions.s.status).toBe("starting");
  expect(resumed.order).toEqual(["s"]);
});
