import { describe, expect, it, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { autoReviewDefault, contextFill, elsewhere, initialState, introOpen, replay, workspaceFolder } from "./reduce";
import { dedupe } from "./store";
import { pickDecision, pickTile, bashRisk, needsLayer2 } from "../picker/pick";
import { layout } from "../components/FlowDiagram";
import { needsQueue } from "../picker/queue";
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

  test("a request Never ask let through draws no card, and rm -fr rates high like rm -rf (I109)", () => {
    const auto: MrEvent = { ...perm("p9", "Bash", { command: "ls" }), payload: { request_id: "p9", tool: "Bash", input: { command: "ls" }, auto_allowed: true } };
    const st = replay([...base, auto]);
    expect(st.sessions.s.pending).toEqual([]);
    expect(st.sessions.s.status).not.toBe("needs_you");
    expect(pickDecision(replay([...base, perm("p8", "Bash", { command: "rm -fr ~/code" })]).sessions.s.pending[0]).spec).toMatchObject({ risk: "high" });
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

test("a turn that ends with plan steps still open says the plan was left open (MR-121)", () => {
  const ev = (id: string, kind: string, payload: Record<string, unknown>): MrEvent => ({ id, session_id: "s", kind, payload, anchor: null, created_at: 1 });
  const steps = (last: string) => [{ step: "Build", status: "done" }, { step: "Verify", status: "done" }, { step: "Merge", status: last }];
  const base = [
    ev("E1", "ui.session_requested", { prompt: "Do it", cwd: "/w", kind: "blank" }),
    ev("E2", "plan.updated", { steps: steps("doing") }),
    ev("E3", "sidecar.sdk", { message: { type: "assistant", message: { content: [{ type: "text", text: "Merged. All done." }] } } }),
    ev("E4", "sidecar.sdk", { message: { type: "result", is_error: false, result: "x" } }),
  ];
  const open = pickTile(replay(base).sessions.s);
  expect(open).toMatchObject({ state: "idle", planOpen: true, step: "Plan left open · 2 of 3" });
  const closed = pickTile(replay([...base.slice(0, 3), ev("E3b", "plan.updated", { steps: steps("done") }), base[3]]).sessions.s);
  expect(closed).toMatchObject({ state: "review", planOpen: false, step: "All 3 steps done" });
});

test("a finished turn with a script still running in the background stays Working, not Waiting", () => {
  const ev = (id: string, kind: string, payload: Record<string, unknown>): MrEvent => ({ id, session_id: "s", kind, payload, anchor: null, created_at: 1 });
  const tasks = (list: { task_id: string; description: string }[]) => ev(`T${list.length}`, "sidecar.sdk", { message: { type: "system", subtype: "background_tasks_changed", tasks: list } });
  const base = [
    ev("D1", "ui.session_requested", { prompt: "p", cwd: "/w" }),
    ev("D2", "sidecar.sdk", { message: { type: "assistant", message: { content: [{ type: "text", text: "Tests are running in the background." }] } } }),
    tasks([{ task_id: "b1", description: "Run the test suite" }]),
    ev("D3", "sidecar.sdk", { message: { type: "result", is_error: false, result: "x" } }),
  ];
  const tile = pickTile(replay(base).sessions.s);
  expect(tile.state).toBe("working");
  expect(tile.step).toBe("Running in background");
  expect(tile.doing).toBe("Running: Run the test suite");
  expect(pickTile(replay([...base, { ...tasks([]), id: "D4" }]).sessions.s).state).toBe("idle");
});

test("an active /goal shows until it's met, cleared or the session ends", () => {
  const ev = (id: string, kind: string, payload: Record<string, unknown>): MrEvent => ({ id, session_id: "s", kind, payload, anchor: null, created_at: 1 });
  const goal = (id: string, value: Record<string, unknown> | null) => ev(id, "sidecar.sdk", { message: { type: "active_goal", value, uuid: "u", session_id: "x" } });
  const base = [ev("G1", "ui.session_requested", { prompt: "p", cwd: "/w" }), goal("G2", { condition: "bun test exits 0", iterations: 0, set_at: 5, tokens_at_start: 100 })];
  expect(replay(base).sessions.s.goal).toEqual({ condition: "bun test exits 0", iterations: 0, setAt: 5, lastReason: null });
  const notMet = [...base, goal("G3", { condition: "bun test exits 0", iterations: 2, set_at: 5, tokens_at_start: 100, last_reason: "2 tests fail" })];
  expect(replay(notMet).sessions.s.goal).toMatchObject({ iterations: 2, lastReason: "2 tests fail" });
  expect(replay([...notMet, goal("G4", null)]).sessions.s.goal).toBeNull();
  expect(replay([...notMet, ev("G4", "sidecar.session_ended", { ok: true })]).sessions.s.goal).toBeNull();
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

test("a workspace starts in its pinned folder, else where its last session ran (MR-65)", () => {
  const ev = (id: string, kind: string, payload: Record<string, unknown>, session: string | null = null): MrEvent => ({ id, session_id: session, kind, payload, anchor: null, created_at: 1 });
  const base = [
    ev("F1", "ui.workspace_created", { id: "ws_a", name: "Client A", config_dir: "/d/ws_a/claude" }),
    ev("F2", "ui.session_requested", { prompt: "p1", cwd: "/code/one", workspace: "ws_a", kind: "blank" }, "s1"),
    ev("F3", "ui.session_requested", { prompt: "p2", cwd: "/code/two", workspace: "ws_a", kind: "blank" }, "s2"),
    ev("F4", "ui.session_requested", { prompt: "p3", cwd: "/code/mine" }, "s3"),
  ];
  let st = replay(base);
  expect(workspaceFolder(st, "ws_a")).toBe("/code/two");
  expect(workspaceFolder(st, "personal")).toBe("/code/mine");
  st = replay([...base, ev("F5", "ui.workspace_folder_set", { id: "ws_a", folder: "/code/client" })]);
  expect(workspaceFolder(st, "ws_a")).toBe("/code/client");
  st = replay([...base, ev("F5", "ui.workspace_folder_set", { id: "ws_a", folder: "/code/client" }), ev("F6", "ui.workspace_folder_set", { id: "ws_a", folder: null })]);
  expect(workspaceFolder(st, "ws_a")).toBe("/code/two");
  expect(workspaceFolder(replay([base[0]]), "ws_a")).toBeNull();
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

test("workspace tabs keep the order they were dragged into", () => {
  const ev = (id: string, kind: string, payload: Record<string, unknown>): MrEvent => ({ id, session_id: null, kind, payload, anchor: null, created_at: 1 });
  const st = replay([
    ev("W1", "ui.workspace_created", { id: "ws_a", name: "Acme" }),
    ev("W2", "ui.workspace_created", { id: "ws_b", name: "Beta" }),
    ev("W3", "ui.workspaces_reordered", { order: ["ws_b", "personal", "ws_a"] }),
    ev("W4", "ui.workspace_created", { id: "ws_c", name: "Gamma" }),
  ]);
  expect(st.workspaces.map((w) => w.id)).toEqual(["ws_b", "personal", "ws_a", "ws_c"]);
});

test("the theme is set through the log", () => {
  const st = replay([{ id: "T1", session_id: null, kind: "ui.theme_set", payload: { theme: "transit" }, anchor: null, created_at: 1 }]);
  expect(st.theme).toBe("transit");
  expect(replay([]).theme).toBe("control-room");
});

test("layer 3 stores a diagram, and remembers when there was nothing to draw", () => {
  const ev = (id: string, kind: string, payload: Record<string, unknown>): MrEvent => ({ id, session_id: "s", kind, payload, anchor: null, created_at: 1 });
  const plan = "Here's the plan.\n" + ["Reproduce the bug with a failing test", "Find where the token expiry is read", "Fix the off-by-one in the comparison", "Run the whole suite and the e2e check"].map((l, i) => `${i + 1}. ${l} and note anything surprising along the way, then report back.`).join("\n");
  const base = [
    ev("D1", "ui.session_requested", { prompt: "p", cwd: "/w" }),
    ev("D2", "sidecar.sdk", { message: { type: "assistant", message: { content: [{ type: "text", text: plan }] } } }),
    ev("D3", "sidecar.sdk", { message: { type: "result", is_error: false, result: "x" } }),
  ];
  const diagram = { title: "Fix", nodes: [{ id: "a", label: "Reproduce", kind: "step" }, { id: "b", label: "Fix", kind: "step" }, { id: "c", label: "Suite green", kind: "done" }], edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }] };
  const after = replay([...base, ev("D4", "picker.layer3", { item_id: "D2:0", diagram })]);
  expect(after.sessions.s.diagrams["D2:0"]?.nodes).toHaveLength(3);
  // "Nothing worth drawing" is remembered too, so the button says so instead of drawing.
  const none = replay([...base, ev("D4", "picker.layer3", { item_id: "D2:0", diagram: null })]).sessions.s.diagrams;
  expect("D2:0" in none && none["D2:0"] === null).toBe(true);
});

test("the flow layout ranks by longest path and survives cycles", () => {
  const pos = layout({ nodes: [{ id: "a", label: "A", kind: "step" }, { id: "b", label: "B", kind: "decision" }, { id: "c", label: "C", kind: "step" }, { id: "d", label: "D", kind: "done" }], edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "b", to: "d" }, { from: "c", to: "b" }] });
  expect(pos.get("a")!.x).toBeLessThan(pos.get("b")!.x);
  expect(pos.get("b")!.x).toBeLessThan(pos.get("d")!.x);
  expect(pos.size).toBe(4);
});

test("plan limits arrive before any session runs", () => {
  const st = replay([{ id: "L1", session_id: null, kind: "sidecar.limits", payload: { available: true, five_hour: { utilization: 0.15, resetsAt: 1791586200 }, seven_day: { utilization: 0.56, resetsAt: 1 } }, anchor: null, created_at: 1 }]);
  expect(st.usage).toEqual({ fiveHour: 0.15, weekly: 0.56, resetsAt: 1791586200, weeklyResetsAt: 1 });
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
  expect(after.sessions.r.review?.approved).toBe(false);
  const approved = replay([...base, ev("R4", "ui.message_sent", { text: "publish and approve" })]);
  expect(approved.sessions.r.review?.published).toBe(true);
  expect(approved.sessions.r.review?.approved).toBe(true);
  // Claude confirms the post and the core archives the session: nothing is left for you.
  const closed = replay([...base, ev("R4", "ui.message_sent", { text: "publish and approve" }), ev("R5", "flow.review_published", { pr: "#482", comments: 1, approved: true }), ev("R6", "ui.session_archived", { by: "review_published" })]);
  expect(closed.sessions.r.review?.published).toBe(true);
  expect(closed.sessions.r.review?.approved).toBe(true);
  expect(closed.sessions.r.archivedAt).toBe(1);
});

test("a bug report's fix waits in the queue until applied, then asks for a rebuild until one succeeds", async () => {
  const { needsQueue } = await import("../picker/queue");
  const { suggest } = await import("../picker/suggest");
  const ev = (id: string, kind: string, payload: Record<string, unknown>, session: string | null = "g", at = 1): MrEvent => ({ id, session_id: session, kind, payload, anchor: null, created_at: at });
  const base = [
    ev("G1", "ui.session_requested", { prompt: "God-mode mark on Cockpit.\n\nTheir note: lamps are wrong\n\nWhat it showed: x", cwd: "/r-worktrees/g", branch: "mr/g", worktree: "/r-worktrees/g" }),
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

test("look settings replay and a restyle session is an app change", async () => {
  const { isAppChange } = await import("../picker/queue");
  const { cleanTitle } = await import("../picker/title");
  const e = (id: string, payload: Record<string, unknown>): MrEvent => ({ id, session_id: null, kind: "ui.look_set", payload, anchor: null, created_at: 1 });
  expect(replay([e("L1", { scale: 1.12 }), e("L2", { density: "compact" })]).look).toEqual({ scale: 1.12, density: "compact" });
  expect(replay([e("L1", { density: "huge" })]).look.density).toBe("default");
  expect(isAppChange({ title: "Restyle the app: warmer\n\nThis is…" })).toBe(true);
  expect(cleanTitle("Restyle the app: warmer greys\n\nThis is Cockpit's own repo.")).toBe("Style: warmer greys");
});

test("deleting a workspace moves its sessions to Personal's archive as read-only history", () => {
  const e = (id: string, kind: string, payload: Record<string, unknown>, session: string | null = null): MrEvent => ({ id, session_id: session, kind, payload, anchor: null, created_at: Number(id.slice(1)) });
  const st = replay([
    e("W1", "ui.workspace_created", { id: "ws_a", name: "Client A", config_dir: "/d" }),
    e("W2", "ui.session_requested", { prompt: "p", cwd: "/w", workspace: "ws_a" }, "s1"),
    e("W3", "sidecar.session_started", { sdk_session_id: "x" }, "s1"),
    e("W4", "ui.session_requested", { prompt: "q", cwd: "/w" }, "s2"),
    e("W5", "ui.workspace_deleted", { id: "ws_a", name: "Client A" }),
  ]);
  expect(st.workspaces.map((w) => w.id)).toEqual(["personal"]);
  expect(st.sessions.s1).toMatchObject({ workspace: "personal", archivedAt: 5, fromDeleted: "Client A", status: "ended" });
  expect(st.sessions.s2).toMatchObject({ workspace: "personal", archivedAt: null, fromDeleted: null });
});

test("a review waiting on its overview needs you until you start the walkthrough", () => {
  const ev = (id: string, kind: string, payload: Record<string, unknown>): MrEvent => ({ id, session_id: "r", kind, payload, anchor: null, created_at: 1 });
  const base = [
    ev("V1", "ui.session_requested", { prompt: "/review 482", kind: "review", cwd: "/w" }),
    ev("V2", "flow.review_overview", { pr: "#482", title: "t", total_snippets: 2 }),
    ev("V3", "sidecar.sdk", { message: { type: "result", is_error: false, result: "overview" } }),
  ];
  expect(pickTile(replay(base).sessions.r)).toMatchObject({ state: "needs_you", doing: "Overview ready · 2 snippets to walk" });
  const started = replay([...base, ev("V4", "flow.review_snippet", { n: 1, total: 2, title: "x", findings: [] }), ev("V5", "sidecar.sdk", { message: { type: "result", is_error: false, result: "s" } })]);
  expect(pickTile(started.sessions.r).doing).toMatch(/^Snippet 1 of 2/);
});

test("a noted review finding can be taken back out", () => {
  const ev = (id: string, kind: string, payload: Record<string, unknown>): MrEvent => ({ id, session_id: "r", kind, payload, anchor: null, created_at: 1 });
  const base = [ev("N1", "ui.session_requested", { prompt: "/review 1", kind: "review", cwd: "/w" }), ev("N2", "ui.review_noted", { finding_id: "f1" }), ev("N3", "ui.review_noted", { finding_id: "ov:0" })];
  expect(replay(base).sessions.r.review?.noted).toEqual(["f1", "ov:0"]);
  expect(replay([...base, ev("N4", "ui.review_unnoted", { finding_id: "f1" })]).sessions.r.review?.noted).toEqual(["ov:0"]);
});

describe("timeline data (MR-32)", () => {
  const at = (id: string, kind: string, payload: Record<string, unknown>, t: number): MrEvent => ({ id, session_id: "t1", kind, payload, anchor: null, created_at: t });
  const steps = (...xs: [string, string][]) => ({ steps: xs.map(([step, status]) => ({ step, status })) });

  test("a step keeps its start, and its end time sticks once it's done", () => {
    const s = replay([
      at("A1", "ui.session_requested", { prompt: "x", cwd: "/r" }, 0),
      at("A2", "plan.updated", steps(["Read", "doing"], ["Write", "todo"]), 1000),
      at("A3", "plan.updated", steps(["Read", "done"], ["Write", "doing"]), 61_000),
      at("A4", "plan.updated", steps(["Read", "done"], ["Write", "doing"]), 90_000),
      at("A5", "plan.updated", steps(["Read", "done"], ["Write", "done"]), 120_000),
    ]).sessions.t1;
    expect(s.todos[0]).toMatchObject({ since: 1000, doneAt: 61_000 });
    expect(s.todos[1]).toMatchObject({ since: 61_000, doneAt: 120_000 });
  });

  test("a step that arrives already done is a zero-length step", () => {
    const s = replay([at("A1", "ui.session_requested", { prompt: "x", cwd: "/r" }, 0), at("A2", "plan.updated", steps(["Read", "done"]), 5000)]).sessions.t1;
    expect(s.todos[0]).toMatchObject({ since: 5000, doneAt: 5000 });
  });

  test("status changes become spans, and a wait names what it waits on", () => {
    const s = replay([
      at("B1", "ui.session_requested", { prompt: "x", cwd: "/r" }, 0),
      at("B2", "sidecar.session_started", { sdk_session_id: "k" }, 1000),
      at("B3", "sidecar.permission_request", { request_id: "r1", tool: "AskUserQuestion", input: { questions: [{ question: "Which DB?", header: "Migration", options: [] }] } }, 5000),
      at("B4", "sidecar.sdk", { message: { type: "assistant", message: { content: [] } } }, 6000),
      at("B5", "ui.permission_answered", { request_id: "r1" }, 9000),
      at("B6", "sidecar.session_ended", { ok: true }, 20_000),
    ]).sessions.t1;
    expect(s.spans.map((x) => [x.status, x.from, x.to])).toEqual([["starting", 0, 1000], ["working", 1000, 5000], ["needs_you", 5000, 9000], ["working", 9000, 20_000], ["ended", 20_000, null]]);
    expect(s.spans[2].label).toBe("Migration");
  });

  test("a sidecar restart closes the open span as interrupted", () => {
    const s = replay([at("C1", "ui.session_requested", { prompt: "x", cwd: "/r" }, 0), at("C2", "sidecar.session_started", {}, 1000), { id: "C3", session_id: null, kind: "sidecar.ready", payload: {}, anchor: null, created_at: 4000 }]).sessions.t1;
    expect(s.spans.at(-1)).toMatchObject({ status: "interrupted", from: 4000, to: null });
    expect(s.spans.at(-2)).toMatchObject({ status: "working", to: 4000 });
  });
});

test("activity buckets follow clock minutes, so events 40 s apart still spread out (MR-32)", () => {
  const evs: MrEvent[] = [{ id: "G0", session_id: "g", kind: "ui.session_requested", payload: { prompt: "x", cwd: "/r" }, anchor: null, created_at: 0 }];
  for (let i = 1; i <= 15; i++) evs.push({ id: `G${String(i).padStart(2, "0")}`, session_id: "g", kind: "sidecar.sdk", payload: { message: { type: "system" } }, anchor: null, created_at: i * 40_000 });
  const a = replay(evs).sessions.g.activity;
  expect(a.reduce((x, y) => x + y, 0)).toBe(15); // the request itself isn't activity
  expect(Math.max(...a)).toBeLessThanOrEqual(2);
});

test("a rollback after a crash at start is shown until dismissed", () => {
  const e = (id: string, kind: string, payload: Record<string, unknown>): MrEvent => ({ id, session_id: null, kind, payload, anchor: null, created_at: 7 });
  const st = replay([e("C1", "app.recovered", { crashed_slot: "b", slot: "a", log: "=== crash at start · slot b\npanicked" })]);
  expect(st.recovered).toEqual({ crashedSlot: "b", log: "=== crash at start · slot b\npanicked", at: 7 });
  expect(replay([e("C1", "app.recovered", { crashed_slot: "b" }), e("C2", "ui.recovery_dismissed", {})]).recovered).toBeNull();
});

describe("model and effort (MR-73)", () => {
  let n = 0;
  const ev = (kind: string, payload: Record<string, unknown>, session: string | null = "m"): MrEvent => ({ id: `M${String(++n).padStart(4, "0")}`, session_id: session, kind, payload, anchor: null, created_at: 5000 + n });
  const base = [ev("ui.session_requested", { prompt: "x", cwd: "/tmp" }), ev("sidecar.session_started", { sdk_session_id: "k", model: "claude-opus-5-5[1m]" })];

  test("the model list is kept, and a failed lookup doesn't wipe it", () => {
    const rows = [{ value: "haiku", resolved: "claude-haiku-5-5", displayName: "Haiku", description: "", efforts: [] }];
    const st = replay([ev("sidecar.models", { models: rows }, null), ev("sidecar.models", { models: [], error: "timed out" }, null)]);
    expect(st.models).toEqual(rows);
  });

  test("a pick shows at once, a confirm switches the model, and a refusal is shown without losing status", () => {
    const st = replay([...base, ev("ui.model_set", { model: "haiku", effort: "low" }), ev("sidecar.model_set", { model: "haiku", effort: "low", ok: true })]);
    const s = st.sessions.m;
    expect([s.modelChoice, s.effort, s.model, s.modelError, s.status]).toEqual(["haiku", "low", "haiku", null, "working"]);
    const bad = replay([...base, ev("ui.model_set", { effort: "max" }), ev("sidecar.model_set", { effort: "max", ok: false, error: "nope" })]).sessions.m;
    expect([bad.modelChoice, bad.effort, bad.modelError]).toEqual([null, "max", "nope"]);
  });

  test("null goes back to the default; a missing key leaves the other as it is", () => {
    const s = replay([...base, ev("ui.model_set", { model: "sonnet", effort: "high" }), ev("ui.model_set", { model: null })]).sessions.m;
    expect([s.modelChoice, s.effort]).toEqual([null, "high"]);
  });
});

test("your own start-picker kinds are saved, edited and removed through the log (MR-80)", () => {
  const ev = (id: string, kind: string, payload: Record<string, unknown>, session: string | null = null): MrEvent => ({ id, session_id: session, kind, payload, anchor: null, created_at: 1 });
  const saved = [
    ev("K1", "ui.preset_saved", { id: "a", name: "Triage", template: "/triage {text}", worktree: false }),
    ev("K2", "ui.preset_saved", { id: "b", name: "Tests", template: "Write tests for", worktree: true }),
    ev("K3", "ui.preset_saved", { id: "a", name: "Triage it", template: "/triage {text}", worktree: false }),
    ev("K4", "ui.session_requested", { prompt: "/triage 12", cwd: "/w", kind: "blank", preset: "a" }, "s1"),
  ];
  let st = replay(saved);
  expect(st.presets).toEqual([{ id: "a", name: "Triage it", template: "/triage {text}", worktree: false }, { id: "b", name: "Tests", template: "Write tests for", worktree: true }]);
  expect(st.sessions.s1.preset).toBe("a");
  expect(st.sessions.s1.kind).toBe("blank");
  st = replay([...saved, ev("K5", "ui.preset_removed", { id: "a" })]);
  expect(st.presets.map((x) => x.id)).toEqual(["b"]);
  expect(replay([]).presets).toEqual([]);
});

test("commands you run from a reply are tracked to their end, and an app restart loses the running ones (MR-85)", () => {
  const ev = (id: string, kind: string, payload: Record<string, unknown>, session: string | null = "s"): MrEvent => ({ id, session_id: session, kind, payload, anchor: null, created_at: Number(id.slice(1)) });
  const st = replay([
    ev("R1", "ui.session_requested", { prompt: "p", cwd: "/w" }),
    ev("R2", "ui.run_started", { run_id: "a", command: "bun test", cwd: "/w" }),
    ev("R3", "ui.run_started", { run_id: "b", command: "false", cwd: "/w" }),
    ev("R4", "ui.run_started", { run_id: "c", command: "sleep 99", cwd: "/w" }),
    ev("R5", "run.finished", { run_id: "a", code: 0, status: "completed" }),
    ev("R6", "run.finished", { run_id: "b", code: 1, status: "failed" }),
  ]);
  expect(st.sessions.s.runs.map((r) => [r.command, r.status, r.code])).toEqual([["bun test", "completed", 0], ["false", "failed", 1], ["sleep 99", "running", null]]);
  expect(st.sessions.s.status).toBe("starting"); // a run is yours, not Claude's work
  const restarted = replay([ev("R7", "app.started", {}, null)], st);
  expect(restarted.sessions.s.runs.map((r) => r.status)).toEqual(["completed", "failed", "lost"]);
});

describe("compaction window (I63)", () => {
  const ev = (id: string, tokens: number | null): MrEvent => ({ id, session_id: null, kind: "ui.compact_window_set", payload: { tokens }, anchor: null, created_at: 1 });
  test("defaults to 200k; the last choice wins and null means the model's limit", () => {
    expect(replay([]).compactWindow).toBe(200_000);
    expect(replay([ev("A", 400_000), ev("B", 120_000)]).compactWindow).toBe(120_000);
    expect(replay([ev("A", 400_000), ev("B", null)]).compactWindow).toBeNull();
  });
});

describe("session cap (MR-105)", () => {
  const ev = (id: string, cap: unknown): MrEvent => ({ id, session_id: null, kind: "ui.session_cap_set", payload: { cap }, anchor: null, created_at: 1 });
  test("defaults to 10; the last choice wins; junk is ignored", () => {
    expect(replay([]).sessionCap).toBe(10);
    expect(replay([ev("A", 15), ev("B", 4)]).sessionCap).toBe(4);
    expect(replay([ev("A", 6), ev("B", "lots")]).sessionCap).toBe(6);
  });
});

describe("permission mode (I106)", () => {
  const ev = (id: string, mode: unknown): MrEvent => ({ id, session_id: null, kind: "ui.permission_mode_set", payload: { mode }, anchor: null, created_at: 1 });
  test("unchosen until you pick; the last valid pick wins", () => {
    expect(replay([]).permissionMode).toBeNull();
    expect(replay([ev("A", "auto"), ev("B", "default")]).permissionMode).toBe("default");
    expect(replay([ev("A", "acceptEdits"), ev("B", "plan")]).permissionMode).toBe("acceptEdits");
    expect(replay([ev("A", "never")]).permissionMode).toBe("never");
    expect(replay([ev("A", "bypassPermissions")]).permissionMode).toBeNull();
  });
});

describe("Cockpit layer (decision 34)", () => {
  const ev = (id: string, kind: string, payload: Record<string, unknown>, at = "2026-10-11T10:00:00Z"): MrEvent => ({ id, session_id: "S1", kind, payload, anchor: null, created_at: at });
  test("is off until switched on", () => {
    expect(replay([]).cockpitLayer).toBe(false);
    expect(replay([ev("A", "ui.cockpit_layer_set", { on: true })]).cockpitLayer).toBe(true);
  });
  test("meters the month's calls apart from Claude", () => {
    const u = (id: string, at: string, ok = true) => ev(id, "cockpit.usage", { ok, input_tokens: 1000, output_tokens: 200, cost_usd: 0.002 }, at);
    const m = replay([u("A", "2026-09-30T10:00:00Z"), u("B", "2026-10-01T10:00:00Z"), u("C", "2026-10-02T10:00:00Z"), u("D", "2026-10-03T10:00:00Z", false)]).cockpit;
    expect(m).toEqual({ month: "2026-10", calls: 2, tokens: 2400, usd: 0.004, errors: 1 });
  });
});

describe("slash commands and MCP servers (MR-87)", () => {
  let n = 0;
  const ev = (kind: string, payload: Record<string, unknown>): MrEvent => ({ id: `C${String(++n).padStart(4, "0")}`, session_id: "c", kind, payload, anchor: null, created_at: 7000 + n });
  // From a real init: names only, skills and terminal-only commands marked.
  const init = { type: "system", subtype: "init", slash_commands: ["mr-task", "mcp", "doctor"], skills: ["mr-task"], terminal_slash_commands: ["doctor"], mcp_servers: [{ name: "claude.ai Gmail", source: "claudeai", status: "needs-auth" }, { name: "mr", source: "sdk", status: "connected" }] };
  const base = [ev("ui.session_requested", { prompt: "x", cwd: "/tmp" }), ev("sidecar.sdk", { message: init })];

  test("init gives the menu its names and the panel its first status", () => {
    const s = replay(base).sessions.c;
    expect(s.commands.map((c) => [c.name, c.skill, c.terminal])).toEqual([["mr-task", true, false], ["mcp", false, false], ["doctor", false, true]]);
    expect(s.mcp?.servers.map((x) => [x.name, x.status])).toEqual([["claude.ai Gmail", "needs-auth"], ["mr", "connected"]]);
  });

  test("the sidecar's list adds descriptions; an empty failed one keeps what we had", () => {
    const rows = [{ name: "mr-task", description: "Run one task", hint: "<task>", aliases: [], builtin: false, skill: true, terminal: false }];
    const s = replay([...base, ev("sidecar.commands", { commands: rows }), ev("sidecar.commands", { commands: [], error: "gone" })]).sessions.c;
    expect(s.commands).toEqual(rows);
  });

  test("skills found mid-session replace the list, keeping what each name was", () => {
    const s = replay([...base, ev("sidecar.sdk", { message: { type: "system", subtype: "commands_changed", commands: [{ name: "doctor", description: "d", argumentHint: "", builtin: true }, { name: "new-skill", description: "n", argumentHint: "" }] } })]).sessions.c;
    expect(s.commands.map((c) => [c.name, c.skill, c.terminal])).toEqual([["doctor", false, true], ["new-skill", true, false]]);
  });

  test("an MCP action shows as busy until the fresh status says how it went, without counting as activity", () => {
    const before = replay(base).sessions.c;
    const busy = replay([...base, ev("ui.mcp_action", { server: "claude.ai Gmail", action: "reconnect" })]).sessions.c;
    expect(busy.mcp?.busy).toBe("claude.ai Gmail");
    expect(busy.activity).toEqual(before.activity);
    const after = replay([...base, ev("ui.mcp_action", { server: "claude.ai Gmail", action: "reconnect" }), ev("sidecar.mcp_status", { servers: [{ name: "claude.ai Gmail", status: "failed", source: "claudeai", scope: null, error: "401", version: null, url: null, tools: [] }], done: { server: "claude.ai Gmail", action: "reconnect", ok: false, error: "401" } })]).sessions.c;
    expect(after.mcp).toMatchObject({ busy: null, done: { ok: false, error: "401" }, servers: [{ status: "failed", error: "401" }] });
    expect(after.status).toBe(before.status);
  });
});

// God-mode mark: "Show the intro" in Settings did nothing once the intro had been closed in this run.
test("Show the intro reopens the intro after it was closed in the same run", () => {
  const e = (id: string, kind: string): MrEvent => ({ id, session_id: null, kind, payload: {}, anchor: null, created_at: 1 });
  expect(introOpen(initialState, null)).toBe(false); // waits for the replay
  expect(introOpen(replay([e("A1", "app.started")]), null)).toBe(true); // first run
  const closedAt = "O1"; // closed (finished or skipped) when the last event was O1
  const done = [e("A1", "app.started"), e("O1", "ui.onboarded")];
  expect(introOpen(replay(done), closedAt)).toBe(false);
  expect(introOpen(replay([...done, e("O2", "ui.onboarding_reset")]), closedAt)).toBe(true);
  // Closed before ui.onboarded arrives: stays closed.
  expect(introOpen(replay([e("A1", "app.started"), e("X1", "ui.other")]), "A1")).toBe(false);
});

describe("auto-review default (MR-93)", () => {
  test("on in dev builds, off in packaged builds; the user's toggle still wins", () => {
    expect(autoReviewDefault({})).toBe(true);
    expect(autoReviewDefault({ VITE_MR_PACKAGED: "1" })).toBe(false);
    const off = { ...initialState, autoReview: autoReviewDefault({ VITE_MR_PACKAGED: "1" }) };
    const ev = { id: "01A", session_id: null, kind: "ui.auto_review_set", payload: { on: true }, anchor: null, created_at: 1 };
    expect(replay([ev] as never, off).autoReview).toBe(true);
  });
});

describe("auto-review watched repos (MR-170)", () => {
  const set = (id: string, payload: Record<string, unknown>) => ({ id, session_id: null, kind: "ui.auto_review_repos_set", payload, anchor: null, created_at: 1 });
  test("starts empty; each event replaces the whole list; a bad payload changes nothing", () => {
    expect(initialState.autoReviewRepos).toEqual([]);
    const added = replay([set("01A", { repos: ["globex/forge", "acme/shop"] })] as never);
    expect(added.autoReviewRepos).toEqual(["globex/forge", "acme/shop"]);
    const removed = replay([set("01A", { repos: ["globex/forge", "acme/shop"] }), set("01B", { repos: ["acme/shop"] })] as never);
    expect(removed.autoReviewRepos).toEqual(["acme/shop"]);
    expect(replay([set("01A", { repos: ["acme/shop"] }), set("01B", { repos: "x" })] as never).autoReviewRepos).toEqual(["acme/shop"]);
    expect(replay([set("01A", { repos: ["acme/shop", 3] })] as never).autoReviewRepos).toEqual(["acme/shop"]);
  });
});

// Dev and /Applications share one log (MR-99): each row says which copy wrote it.
describe("several copies of the app on one log", () => {
  let n = 0;
  const ev = (kind: string, origin: string | null, payload: Record<string, unknown> = {}, session: string | null = null): MrEvent => ({ id: `E${String(++n).padStart(4, "0")}`, session_id: session, kind, payload, anchor: null, created_at: 2_000_000 + n * 1000, origin });
  const twoCopies = () => [
    ev("app.started", "A"), ev("sidecar.ready", "A"),
    ev("ui.session_requested", "A", { prompt: "mine", cwd: "/tmp/a" }, "sa"), ev("sidecar.session_started", "A", { sdk_session_id: "x" }, "sa"),
    ev("ui.run_started", "A", { run_id: "r1", command: "bun dev" }, "sa"),
    ev("app.started", "B"), ev("sidecar.ready", "B"),
    ev("ui.session_requested", "B", { prompt: "theirs", cwd: "/tmp/b" }, "sb"), ev("sidecar.session_started", "B", { sdk_session_id: "y" }, "sb"),
  ];

  test("another copy starting doesn't stop this copy's sessions or runs", () => {
    const s = replay(twoCopies(), { ...initialState, instance: "A" });
    expect(s.sessions.sa.status).not.toBe("interrupted");
    expect(s.sessions.sa.runs[0].status).toBe("running");
    expect(s.sessions.sb.owner).toBe("B");
  });

  test("a session open in the other copy is shown but driven there", () => {
    const s = replay(twoCopies(), { ...initialState, instance: "A" });
    expect(elsewhere(s, s.sessions.sb)).toBe(true);
    expect(elsewhere(s, s.sessions.sa)).toBe(false);
  });

  test("when the other copy goes, its sessions stop and can be resumed here", () => {
    const s = replay([...twoCopies(), ev("app.stopped", "A", { origin: "B", reason: "gone" })], { ...initialState, instance: "A" });
    expect(s.sessions.sb.status).toBe("interrupted");
    expect(elsewhere(s, s.sessions.sb)).toBe(false);
    expect(s.sessions.sa.status).not.toBe("interrupted");
  });

  test("rows from before origins keep the old rule: a start stops everything", () => {
    const s = replay([ev("sidecar.ready", null), ev("ui.session_requested", null, { prompt: "old" }, "so"), ev("sidecar.session_started", null, { sdk_session_id: "z" }, "so"), ev("sidecar.ready", "A")]);
    expect(s.sessions.so.status).toBe("interrupted");
  });
});

describe("live events from two copies", () => {
  const e = (id: string, at: number): MrEvent => ({ id, session_id: null, kind: "k", payload: {}, anchor: null, created_at: at });

  test("a late row with an older id still applies; repeats don't", () => {
    const d = dedupe();
    d.replayed([e("E1", 1), e("E2", 2)]);
    expect(d.fresh(e("E2", 2))).toBe(false);
    expect(d.fresh(e("E4", 4))).toBe(true);
    expect(d.fresh(e("E3", 3))).toBe(true);
    expect(d.fresh(e("E3", 3))).toBe(false);
  });
});

describe("context meter", () => {
  const sdk = (id: string, message: Record<string, unknown>): MrEvent => ({ id, session_id: "S", kind: "sidecar.sdk", payload: { message }, anchor: null, created_at: 2 });
  const start: MrEvent = { id: "0", session_id: "S", kind: "ui.session_requested", payload: { prompt: "hi", cwd: "/x", kind: "blank" }, anchor: null, created_at: 1 };
  const reply = (id: string, read: number, extra: Record<string, unknown> = {}) => sdk(id, { type: "assistant", message: { content: [], usage: { input_tokens: 2, cache_read_input_tokens: read, cache_creation_input_tokens: 100, output_tokens: 8 } }, ...extra });

  it("tracks the latest main-thread reply, skips subagents, takes the window from the result", () => {
    const s = replay([start, reply("1", 50_000), reply("2", 900_000, { parent_tool_use_id: "toolu_x" }),
      sdk("3", { type: "result", modelUsage: { "claude-haiku-5-5": { costUSD: 0.001, contextWindow: 200_000 }, "claude-opus-5-5[1m]": { costUSD: 2, contextWindow: 1_000_000 } } })]).sessions.S;
    expect(s.context).toEqual({ used: 50_110, window: 1_000_000 });
    expect(contextFill(s, 200_000)).toEqual({ used: 50_110, limit: 200_000, share: 50_110 / 200_000 });
    expect(contextFill(s, null)?.limit).toBe(1_000_000);
  });

  it("a compact resets it to what was kept", () => {
    const s = replay([start, reply("1", 150_000), sdk("2", { type: "system", subtype: "compact_boundary", compact_metadata: { pre_tokens: 150_110, post_tokens: 15_000 } })]).sessions.S;
    expect(s.context.used).toBe(15_000);
  });
});

describe("attachments", () => {
  let n = 0;
  const ev = (kind: string, payload: Record<string, unknown>): MrEvent => ({ id: `A${String(++n).padStart(4, "0")}`, session_id: "s1", kind, payload, anchor: null, created_at: 1_000_000 + n * 1000 });
  const shot = { path: "/data/attachments/01-shot.png", name: "Pasted image 1.png", mime: "image/png", size: 2048 };
  test("a first prompt with files shows as your first message; a message keeps its files", () => {
    const st = replay([
      ev("ui.session_requested", { cwd: "/r", prompt: "what's wrong here?", kind: "blank", attachments: [shot] }),
      ev("ui.message_sent", { text: "and this", attachments: [{ path: "/r/spec.pdf", name: "spec.pdf", mime: "application/pdf" }, { bogus: 1 }] }),
      ev("ui.message_sent", { text: "plain" }),
    ]);
    const users = st.sessions.s1.transcript.filter((t) => t.kind === "user");
    expect(users.map((t) => t.kind === "user" && [t.text, t.attachments?.map((a) => a.name)])).toEqual([
      ["what's wrong here?", ["Pasted image 1.png"]],
      ["and this", ["spec.pdf"]],
      ["plain", undefined],
    ]);
  });
  test("a first prompt without files adds no message", () => {
    expect(replay([ev("ui.session_requested", { cwd: "/r", prompt: "go", kind: "blank" })]).sessions.s1.transcript).toEqual([]);
  });
});

test("moving a session puts it in the other workspace, and a resume keeps it there", () => {
  const e = (id: string, kind: string, payload: Record<string, unknown>, session: string | null = null): MrEvent => ({ id, session_id: session, kind, payload, anchor: null, created_at: Number(id.slice(1)) });
  const st = replay([
    e("M1", "ui.workspace_created", { id: "ws_a", name: "Client A", config_dir: "/d" }),
    e("M2", "ui.session_requested", { prompt: "p", cwd: "/w" }, "s1"),
    e("M3", "ui.session_moved", { from: "personal", to: "ws_a", copied: 1 }, "s1"),
    e("M4", "ui.session_requested", { prompt: "go on", cwd: "/w", resume: "x", workspace: "ws_a" }, "s1"),
  ]);
  expect(st.sessions.s1.workspace).toBe("ws_a");
  expect(st.order).toEqual(["s1"]);
});

test("a move asked mid-turn waits for the turn, can be cancelled, and says why it failed (MR-177)", () => {
  const e = (id: string, kind: string, payload: Record<string, unknown>): MrEvent => ({ id, session_id: "s1", kind, payload, anchor: null, created_at: Number(id.slice(1)) });
  const base = [e("Q1", "ui.session_requested", { prompt: "p", cwd: "/w" }), e("Q2", "ui.session_move_queued", { from: "personal", to: "ws_a" })];
  const queued = replay(base).sessions.s1;
  expect(queued.moveTo).toBe("ws_a");
  expect(queued.workspace).toBe("personal");
  const moved = replay([...base, e("Q3", "ui.session_moved", { from: "personal", to: "ws_a", copied: 1 })]).sessions.s1;
  expect([moved.workspace, moved.moveTo]).toEqual(["ws_a", null]);
  expect(replay([...base, e("Q3", "ui.session_move_cancelled", { to: "ws_a" })]).sessions.s1.moveTo).toBeNull();
  const failed = replay([...base, e("Q3", "ui.session_move_failed", { to: "ws_a", error: "it didn't stop in time; try again" })]).sessions.s1;
  expect([failed.workspace, failed.moveTo, failed.moveFailed]).toEqual(["personal", null, "it didn't stop in time; try again"]);
});

describe("expired sign-in (MR-153)", () => {
  let n = 0;
  const ev = (kind: string, payload: Record<string, unknown>): MrEvent => ({ id: `L${String(++n).padStart(3, "0")}`, session_id: "S", kind, payload, anchor: null, created_at: n });
  const start = [ev("ui.session_requested", { prompt: "fix it", cwd: "/r" }), ev("sidecar.session_started", { sdk_session_id: "x" })];
  // What Claude Code sends when its login ran out (copied from a real log).
  const refused = () => [
    ev("sidecar.sdk", { message: { type: "assistant", error: "authentication_failed", is_api_error_message: true, message: { content: [{ type: "text", text: "Not logged in · Please run /login" }] } } }),
    ev("sidecar.sdk", { message: { type: "result", is_error: true, result: "Not logged in · Please run /login" } }),
  ];

  it("keeps the refused message to send again", () => {
    const s = replay([...start, ev("ui.message_sent", { text: "now the tests" }), ...refused()]).sessions.S;
    expect(s.signedOut).toEqual({ retry: "now the tests" });
    expect(s.error).toBeNull();
  });

  it("falls back to continuing when the very first turn was refused", () => {
    expect(replay([...start, ...refused()]).sessions.S.signedOut).toEqual({ retry: "Continue where you left off." });
  });

  it("waits in the needs-you queue, and the tile says so", () => {
    const s = replay([...start, ev("ui.message_sent", { text: "go" }), ...refused()]).sessions.S;
    expect(needsQueue([s], []).map((q) => q.kind)).toEqual(["signin"]);
    expect(pickTile(s).state).toBe("needs_you");
  });

  it("clears once Claude answers again", () => {
    const s = replay([...start, ev("ui.message_sent", { text: "go" }), ...refused(), ev("ui.relogin_restart", {}), ev("sidecar.sdk", { message: { type: "assistant", message: { content: [{ type: "text", text: "On it." }] } } })]).sessions.S;
    expect(s.signedOut).toBeNull();
  });
});

test("a doc-change note from Cockpit shows in the transcript as from the doc, not from you (MR-168)", () => {
  const ev = (id: string, kind: string, payload: Record<string, unknown>): MrEvent => ({ id, session_id: "b", kind, payload, anchor: null, created_at: 1 });
  const s = replay([
    ev("B1", "ui.session_requested", { prompt: "build it", kind: "blank", cwd: "/w" }),
    ev("B2", "sidecar.sdk", { message: { type: "result", is_error: false, result: "ok" } }),
    ev("B3", "doc.relay", { doc_id: "d", from: "p", text: "Working doc \"Retries\" was just changed" }),
  ]).sessions.b;
  expect(s.transcript.at(-1)).toMatchObject({ kind: "user", via: "doc", text: "Working doc \"Retries\" was just changed" });
  // A note queued for your next message shows nothing until it's delivered.
  const queued = replay([ev("B1", "ui.session_requested", { prompt: "build it", kind: "blank", cwd: "/w" }), ev("B2", "doc.relay_waiting", { doc_id: "d", text: "later" })]).sessions.b;
  expect(queued.transcript.some((t) => t.kind === "user" && t.via === "doc")).toBe(false);
  expect(s.status).toBe("working");
});

describe("spawned sessions (MR-176)", () => {
  const ev = (id: string, sid: string, kind: string, payload: Record<string, unknown>): MrEvent => ({ id, session_id: sid, kind, payload, anchor: null, created_at: 1 });
  test("a session requested with a parent names it; one you start doesn't", () => {
    const st = replay([
      ev("A1", "p", "ui.session_requested", { prompt: "Plan the launch", cwd: "/w" }),
      ev("A2", "c", "ui.session_requested", { prompt: "Write the changelog", cwd: "/w", parent: "p" }),
      ev("A3", "c", "ui.session_requested", { prompt: "Continue", cwd: "/w", resume: "sdk" }),
    ]);
    expect(st.sessions.c.spawnedBy).toEqual({ id: "p", title: "Plan the launch" });
    expect(st.sessions.p.spawnedBy).toBeNull();
  });
});

describe("spawned session reports (MR-178)", () => {
  test("a child's report shows in the parent's transcript as from the child, not from you", () => {
    const st = replay([
      { id: "A1", session_id: "p", kind: "ui.session_requested", payload: { prompt: "Plan", cwd: "/w" }, anchor: null, created_at: 1 },
      { id: "A2", session_id: "p", kind: "session.child_report", payload: { child: "c", text: "[Report from spawned session \"x\" (c), which finished a turn]\nDone" }, anchor: null, created_at: 2 },
    ]);
    const last = st.sessions.p.transcript.at(-1);
    expect(last).toMatchObject({ kind: "user", via: "child" });
  });
});

describe("session cost", () => {
  const ev = (id: string, kind: string, payload: Record<string, unknown>): MrEvent => ({ id, session_id: "S", kind, payload, anchor: null, created_at: 2 });
  const start = ev("0", "ui.session_requested", { prompt: "hi", cwd: "/x", kind: "blank" });
  const result = (id: string, total: number) => ev(id, "sidecar.sdk", { message: { type: "result", is_error: false, result: "", total_cost_usd: total } });

  it("adds each turn's share of the SDK's running total, and starts over when a new run reports less", () => {
    const s = replay([start, result("1", 1.0), result("2", 1.5), result("3", 2.25), result("4", 0.5), result("5", 0.75)]).sessions.S;
    expect(s.costUsd).toBeCloseTo(3.0);
    expect(s.transcript.flatMap((t) => (t.kind === "result" ? [t.costUsd] : []))).toEqual([1.0, 0.5, 0.75, 0.5, 0.25]);
  });
});
