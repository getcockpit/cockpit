import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { replay } from "./reduce";
import { pickDecision, pickTile, bashRisk, needsLayer2, wantsDiagram } from "../picker/pick";
import { layout } from "../components/FlowDiagram";
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
    expect(state.usage.weekly).toBeCloseTo(0.52);
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

test("a turn that ends with a question in prose shows as needs-you", () => {
  const ev = (id: string, kind: string, payload: Record<string, unknown>): MrEvent => ({ id, session_id: "s", kind, payload, anchor: null, created_at: 1 });
  const st = replay([
    ev("B1", "ui.session_requested", { prompt: "p", cwd: "/w" }),
    ev("B2", "sidecar.sdk", { message: { type: "assistant", message: { content: [{ type: "text", text: "I can do A or B.\nWhich one do you prefer?" }] } } }),
    ev("B3", "sidecar.sdk", { message: { type: "result", is_error: false, result: "x" } }),
  ]);
  const tile = pickTile(st.sessions.s);
  expect(tile.state).toBe("needs_you");
  expect(tile.doing).toBe("Asks: Which one do you prefer?");
});

test("layer 2 catches a question asked without a question mark, and meters the call", () => {
  const ev = (id: string, kind: string, payload: Record<string, unknown>): MrEvent => ({ id, session_id: "s", kind, payload, anchor: null, created_at: Date.UTC(2026, 9, 9) });
  const base = [
    ev("C1", "ui.session_requested", { prompt: "p", cwd: "/w" }),
    ev("C2", "sidecar.sdk", { message: { type: "assistant", message: { content: [{ type: "text", text: "I can do A or B. Let me know which you prefer." }] } } }),
    ev("C3", "sidecar.sdk", { message: { type: "result", is_error: false, result: "x" } }),
  ];
  const before = replay(base);
  expect(pickTile(before.sessions.s).state).toBe("idle");
  expect(needsLayer2(before.sessions.s)).toEqual({ id: "C2:0", text: "I can do A or B. Let me know which you prefer." });
  const after = replay([...base, ev("C4", "picker.layer2", { item_id: "C2:0", label: "question", p: 0.93, layer: "model", tokens: 140 })]);
  expect(pickTile(after.sessions.s).state).toBe("needs_you");
  expect(needsLayer2(after.sessions.s)).toBeNull();
  expect(after.sessions.s.lastActivity).toBe(before.sessions.s.lastActivity);
  expect(after.clef).toEqual({ day: "2026-10-09", calls: 1, tokens: 140, errors: 0 });
  // The code fallback records a label too, so the item isn't re-asked, but it never overrides layer 1.
  const fallback = replay([...base, ev("C4", "picker.layer2", { item_id: "C2:0", label: "other", p: 1, layer: "code", tokens: 0 })]);
  expect(pickTile(fallback.sessions.s).state).toBe("idle");
  expect(fallback.clef.calls).toBe(0);
});

test("workspaces are created from the log and sessions stay in theirs", () => {
  const ev = (id: string, kind: string, payload: Record<string, unknown>, session: string | null = null): MrEvent => ({ id, session_id: session, kind, payload, anchor: null, created_at: 1 });
  const st = replay([
    ev("W1", "ui.workspace_created", { id: "ws_a", name: "Client A", config_dir: "/d/ws_a/claude" }),
    ev("W2", "ui.session_requested", { prompt: "p1", cwd: "/w", workspace: "ws_a" }, "s1"),
    ev("W3", "ui.session_requested", { prompt: "p2", cwd: "/w" }, "s2"),
    ev("W4", "ui.workspace_renamed", { id: "ws_a", name: "Acme" }),
  ]);
  expect(st.workspaces.map((w) => w.name)).toEqual(["Personal", "Acme"]);
  expect(st.sessions.s1.workspace).toBe("ws_a");
  expect(st.sessions.s2.workspace).toBe("personal");
});

test("the theme is set through the log", () => {
  const st = replay([{ id: "T1", session_id: null, kind: "ui.theme_set", payload: { theme: "transit" }, anchor: null, created_at: 1 }]);
  expect(st.theme).toBe("transit");
  expect(replay([]).theme).toBe("control-room");
});

test("layer 3 asks for a diagram of a long step list once, and stores the answer", () => {
  const ev = (id: string, kind: string, payload: Record<string, unknown>): MrEvent => ({ id, session_id: "s", kind, payload, anchor: null, created_at: 1 });
  const plan = "Here's the plan.\n" + ["Reproduce the bug with a failing test", "Find where the token expiry is read", "Fix the off-by-one in the comparison", "Run the whole suite and the e2e check"].map((l, i) => `${i + 1}. ${l} and note anything surprising along the way, then report back.`).join("\n");
  const base = [
    ev("D1", "ui.session_requested", { prompt: "p", cwd: "/w" }),
    ev("D2", "sidecar.sdk", { message: { type: "assistant", message: { content: [{ type: "text", text: plan }] } } }),
    ev("D3", "sidecar.sdk", { message: { type: "result", is_error: false, result: "x" } }),
  ];
  expect(wantsDiagram(replay(base).sessions.s)?.id).toBe("D2:0");
  const diagram = { title: "Fix", nodes: [{ id: "a", label: "Reproduce", kind: "step" }, { id: "b", label: "Fix", kind: "step" }, { id: "c", label: "Suite green", kind: "done" }], edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }] };
  const after = replay([...base, ev("D4", "picker.layer3", { item_id: "D2:0", diagram })]);
  expect(after.sessions.s.diagrams["D2:0"]?.nodes).toHaveLength(3);
  expect(wantsDiagram(after.sessions.s)).toBeNull();
  // "Nothing worth drawing" is remembered too, so it isn't asked again.
  expect(wantsDiagram(replay([...base, ev("D4", "picker.layer3", { item_id: "D2:0", diagram: null })]).sessions.s)).toBeNull();
  // Short chat never triggers it.
  expect(wantsDiagram(replay([base[0], ev("D2", "sidecar.sdk", { message: { type: "assistant", message: { content: [{ type: "text", text: "1. a\n2. b\n3. c" }] } } }), base[2]]).sessions.s)).toBeNull();
});

test("the flow layout ranks by longest path and survives cycles", () => {
  const pos = layout({ nodes: [{ id: "a", label: "A", kind: "step" }, { id: "b", label: "B", kind: "decision" }, { id: "c", label: "C", kind: "step" }, { id: "d", label: "D", kind: "done" }], edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "b", to: "d" }, { from: "c", to: "b" }] });
  expect(pos.get("a")!.x).toBeLessThan(pos.get("b")!.x);
  expect(pos.get("b")!.x).toBeLessThan(pos.get("d")!.x);
  expect(pos.size).toBe(4);
});

test("plan limits arrive before any session runs", () => {
  const st = replay([{ id: "L1", session_id: null, kind: "sidecar.limits", payload: { available: true, five_hour: { utilization: 0.15, resetsAt: 1791586200 }, seven_day: { utilization: 0.56, resetsAt: 1 } }, anchor: null, created_at: 1 }]);
  expect(st.usage).toEqual({ fiveHour: 0.15, weekly: 0.56, resetsAt: 1791586200 });
  expect(replay([{ id: "L1", session_id: null, kind: "sidecar.limits", payload: { available: false, error: "x" }, anchor: null, created_at: 1 }]).usage.fiveHour).toBeNull();
});

test("onboarding shows until finished, and limits double as the sign-in check", () => {
  const e = (id: string, kind: string, payload: Record<string, unknown>): MrEvent => ({ id, session_id: null, kind, payload, anchor: null, created_at: 1 });
  expect(replay([]).onboarded).toBe(false);
  expect(replay([e("O1", "ui.onboarded", {})]).onboarded).toBe(true);
  expect(replay([e("O1", "ui.onboarded", {}), e("O2", "ui.onboarding_reset", {})]).onboarded).toBe(false);
  expect(replay([e("L1", "sidecar.limits", { available: false, error: "not logged in" })]).account).toEqual({ checked: true, signedIn: false, plan: null });
  expect(replay([e("L1", "sidecar.limits", { available: true, plan: "max", five_hour: null, seven_day: null })]).account).toEqual({ checked: true, signedIn: true, plan: "max" });
});

test("marking a session done archives it; restore and resume bring it back", () => {
  const ev = (id: string, kind: string, payload: Record<string, unknown> = {}): MrEvent => ({ id, session_id: "s", kind, payload, anchor: null, created_at: Number(id.slice(1)) * 1000 });
  const base = [ev("A1", "ui.session_requested", { prompt: "p", cwd: "/w" }), ev("A2", "sidecar.session_started", { sdk_session_id: "sdk-1" })];
  const done = replay([...base, ev("A3", "ui.session_archived")]);
  expect(done.sessions.s.archivedAt).toBe(3000);
  expect(done.sessions.s.lastActivity).toBe(2000);
  expect(replay([...base, ev("A3", "ui.session_archived"), ev("A4", "ui.session_unarchived")]).sessions.s.archivedAt).toBeNull();
  expect(replay([...base, ev("A3", "ui.session_archived"), ev("A4", "ui.session_requested", { prompt: "Continue", cwd: "/w", resume: "sdk-1" })]).sessions.s.archivedAt).toBeNull();
});

test("a review is over once you publish it", () => {
  const ev = (id: string, kind: string, payload: Record<string, unknown>): MrEvent => ({ id, session_id: "r", kind, payload, anchor: null, created_at: 1 });
  const base = [
    ev("R1", "ui.session_requested", { prompt: "/review 482", kind: "review", cwd: "/w" }),
    ev("R2", "flow.review_publish_ready", { comments: [{ severity: "blocking", text: "x" }], verdict: "Request changes" }),
    ev("R3", "sidecar.sdk", { message: { type: "result", is_error: false, result: "ready" } }),
  ];
  expect(pickTile(replay(base).sessions.r).state).toBe("needs_you");
  const after = replay([...base, ev("R4", "ui.message_sent", { text: "publish" }), ev("R5", "sidecar.sdk", { message: { type: "result", is_error: false, result: "done" } })]);
  expect(after.sessions.r.review?.published).toBe(true);
  expect(pickTile(after.sessions.r).state).not.toBe("needs_you");
});

test("a bug report's fix waits in the queue until applied, then asks for a rebuild until one succeeds", async () => {
  const { needsQueue } = await import("../picker/queue");
  const { suggest } = await import("../picker/suggest");
  const ev = (id: string, kind: string, payload: Record<string, unknown>, session: string | null = "g", at = 1): MrEvent => ({ id, session_id: session, kind, payload, anchor: null, created_at: at });
  const base = [
    ev("G1", "ui.session_requested", { prompt: "God-mode mark on Minority report.\n\nTheir note: lamps are wrong\n\nWhat it showed: x", cwd: "/r-worktrees/g", branch: "mr/g", worktree: "/r-worktrees/g" }),
    ev("G2", "sidecar.sdk", { message: { type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "Edit", input: { file_path: "a.ts", old_string: "a", new_string: "b" } }] } } }),
    ev("G3", "sidecar.sdk", { message: { type: "result", is_error: false, result: "done" } }),
  ];
  const s0 = replay(base);
  expect(needsQueue(Object.values(s0.sessions), []).map((q) => q.kind)).toEqual(["fix"]);
  const s1 = replay([...base, ev("G4", "ui.fix_applied", { branch: "mr/g" }, "g", 5)]);
  expect(needsQueue(Object.values(s1.sessions), [])).toHaveLength(0);
  expect(suggest(s1, [], { review: [], mine: [] }, new Set()).map((x) => x.label)).toContain("Rebuild & relaunch");
  const s2 = replay([...base, ev("G4", "ui.fix_applied", { branch: "mr/g" }, "g", 5), ev("B1", "selfbuild.finished", { ok: true }, null, 9)]);
  expect(suggest(s2, [], { review: [], mine: [] }, new Set()).map((x) => x.label)).not.toContain("Rebuild & relaunch");
});
