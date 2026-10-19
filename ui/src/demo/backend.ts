// Demo backend (MR-40): the UI running in a plain browser against a scripted fake core, so every
// job-to-be-done flow can be walked, screenshotted and judged without Tauri, Claude or usage.
// Open http://localhost:1420/?demo=<scenario> (see scenarios.ts). Never loaded inside the app.

import { mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { Cadence, McpServer, MrEvent } from "../state/types";
import { cadenceExpr, nextRuns } from "../components/cron";
import type { Doc } from "../state/docs";
import { watchSlug } from "../state/prRepo";
import { REVIEW_SNIPPETS, SCENARIOS, type Scenario } from "./scenarios";

let seq = 0;
const events: MrEvent[] = [];
const usage: { kind: string; name: string; detail: string; at: number }[] = [];
let docs: Doc[] = [];
const id = () => `D${String(++seq).padStart(9, "0")}`;

function record(session: string | null, kind: string, payload: Record<string, unknown>, at = Date.now()): MrEvent {
  const ev: MrEvent = { id: id(), session_id: session, kind, payload, anchor: null, created_at: at };
  events.push(ev);
  applyDocEvent(ev);
  void emit("mr-event", ev);
  return ev;
}
const sdk = (session: string, message: Record<string, unknown>) => record(session, "sidecar.sdk", { message });
const later = (ms: number, f: () => void) => setTimeout(f, ms);

function applyDocEvent(ev: MrEvent) {
  const p = ev.payload as Record<string, string>;
  const d = docs.find((x) => x.id === p.doc_id);
  if (!d) return;
  const b = d.blocks[p.block_id];
  if (ev.kind === "ui.doc_decision" && b) {
    b.decision = p.choice;
    // Like the core: a brief's risk marked fine isn't a correction (MR-116).
    if (d.kind === "brief" && !(b.section === "risk" && p.choice === "Fine")) d.pending_changes = [...d.pending_changes, b.section === "risk" ? `Confirmed this looks wrong: "${b.takeaway}"` : `Decided "${b.takeaway}": ${p.choice}`];
  }
  if (ev.kind === "ui.doc_note") d.pending_notes = [...d.pending_notes, [p.block_id, p.text]];
  if (ev.kind === "ui.doc_edit" && b) { (b as Record<string, unknown>)[p.field] = p.value; d.pending_changes = [...new Set([...d.pending_changes, p.block_id])]; }
  docs = [...docs];
}

// A scripted agent: plans with todos, reads and edits, asks to run the tests, then recaps.
function runAgent(session: string, prompt: string) {
  const items: [string, string][] = [["Read the relevant code", "Reading the code"], ["Make the change", "Making the change"], ["Run the tests", "Running the tests"], ["Summarise", "Summarising"]];
  const todos = (n: number) => items.map(([content, activeForm], i) => ({ content, activeForm, status: i < n ? "completed" : i === n ? "in_progress" : "pending" }));
  later(400, () => record(session, "sidecar.session_started", { sdk_session_id: `sdk-${session}`, model: "claude-opus-5-5" }));
  later(900, () => sdk(session, { type: "assistant", message: { content: [{ type: "text", text: `On it: “${prompt.slice(0, 80)}”. Looking at the code first.` }, { type: "tool_use", id: "t1", name: "TodoWrite", input: { todos: todos(0) } }] } }));
  later(1700, () => sdk(session, { type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "src/app/routes.ts" } }] } }));
  later(2600, () => sdk(session, { type: "assistant", message: { content: [{ type: "tool_use", id: "t3", name: "TodoWrite", input: { todos: todos(1) } }, { type: "tool_use", id: "t4", name: "Edit", input: { file_path: "src/app/routes.ts", old_string: "router.beforeEach(render);\nrouter.beforeEach(authGuard);", new_string: "// The guard must run first, or /login renders and bounces back\nrouter.beforeEach(authGuard);\nrouter.beforeEach(render);" } }] } }));
  later(3600, () => sdk(session, { type: "assistant", message: { content: [{ type: "tool_use", id: "t5", name: "TodoWrite", input: { todos: todos(2) } }] } }));
  later(4000, () => record(session, "sidecar.permission_request", { request_id: `p-${session}`, tool: "Bash", input: { command: "bun test", description: "Run the test suite" }, suggestions: null, decision_reason: null }));
}

function finishAgent(session: string, allowed: boolean) {
  const recap = allowed
    ? "Done. Here's what changed:\n1. Moved the last 3 readers from invoices_v1 to invoices.\n2. Backfilled 1,204 rows that only existed in the old table.\n3. Dropped invoices_v1 and the 2 views that depended on it.\n4. All 142 tests pass.\nWant me to open a PR, or remove the dead code next?"
    : "Okay, production is untouched. Two safer ways forward:\n1. Run the same drop on staging first and show you the row counts.\n2. List the 2 views that CASCADE would also remove, so you can decide.\nWant me to start with staging?";
  later(300, () => sdk(session, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t5" }] } }));
  later(1200, () => sdk(session, { type: "assistant", message: { content: [{ type: "text", text: recap }] } }));
  later(1400, () => sdk(session, { type: "result", is_error: false, result: recap, total_cost_usd: 0.42 }));
}

function diagramFor(text: string) {
  const steps = text.split("\n").filter((l) => /^\s*(\d+[.)]|[-*•])\s+/.test(l)).map((l) => l.replace(/^\s*(\d+[.)]|[-*•])\s+/, "")).slice(0, 6);
  if (steps.length < 2) return null;
  const nodes = steps.map((s, i) => ({ id: `n${i}`, label: s.split(/[,.;:]/)[0].slice(0, 44), kind: /pass|green|done/i.test(s) ? "done" : /risk|flaky|fail/i.test(s) ? "risk" : /\?|decide|whether/i.test(s) ? "decision" : "step" }));
  return { title: null, nodes, edges: nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id })) };
}

// Scripted /review and /pr-address replies, so the J8 flows can be walked end to end.
function scripted(sid: string, text: string): boolean {
  const done = (r: string) => later(700, () => sdk(sid, { type: "result", is_error: false, result: r, total_cost_usd: 0.04 }));
  if (sid === "R") {
    // Claude carries on from the snippet it showed last, so a jump moves "next" too.
    const shown = Number([...events].reverse().find((e) => e.session_id === "R" && e.kind === "flow.review_snippet")?.payload.n ?? 0);
    if (text === "next" && shown < REVIEW_SNIPPETS.length) { later(500, () => record("R", "flow.review_snippet", REVIEW_SNIPPETS[shown])); done("snippet"); return true; }
    if (text === "next") {
      const noted = events.filter((e) => e.session_id === "R" && e.kind === "ui.review_noted").map((e) => String(e.payload.finding_id));
      const all = REVIEW_SNIPPETS.flatMap((x) => x.findings);
      later(500, () => record("R", "flow.review_publish_ready", { comments: all.filter((f) => noted.includes(f.id)).map((f) => ({ severity: f.severity, at: f.at, text: f.text })), verdict: noted.length ? "Request changes" : "Approve", dropped: 0 }));
      done("ready"); return true;
    }
    const jump = /^snippet (\d+)$/.exec(text);
    if (jump && REVIEW_SNIPPETS[Number(jump[1]) - 1]) { later(500, () => record("R", "flow.review_snippet", REVIEW_SNIPPETS[Number(jump[1]) - 1])); done("snippet"); return true; }
    // Posted: Claude reports it and the core archives the session, nothing is left for you.
    if (text === "publish" || text === "publish and approve") { later(500, () => { record("R", "flow.review_published", { pr: "#482", comments: 1, approved: text !== "publish" }); record("R", "ui.session_archived", { by: "review_published" }); }); done("published"); return true; }
    if (text.startsWith("note ")) { done("noted"); return true; }
    if (text === "ok") { later(1500, () => record("R", "flow.review_snippet", REVIEW_SNIPPETS[0])); later(1700, () => sdk(sid, { type: "result", is_error: false, result: "snippet", total_cost_usd: 0.04 })); return true; }
    if (text.startsWith("Add this to the review") || text.startsWith("About ")) { later(900, () => sdk(sid, { type: "assistant", message: { content: [{ type: "text", text: "Added to your review." }] } })); done("ok"); return true; }
  }
  // Every thread is drawn up front (MR-126): a pick names its thread, Claude fixes it, then wraps up.
  const pick = /^Thread (\S+) · Option /.exec(text);
  if (sid === "X" && pick) {
    const id = pick[1];
    const left = ["t1", "t2"].filter((t) => t !== id && !events.some((e) => e.session_id === "X" && e.kind === "flow.address_reply" && e.payload.id === t));
    later(300, () => record("X", "flow.address_fixing", { id }));
    later(1500, () => record("X", "flow.address_proof", { id, checks: [{ label: "Tests pass", ok: true, proof: "211 passed" }, { label: "Memory stays flat on 2M rows", ok: true, proof: "peak 180 MB" }] }));
    later(2000, () => record("X", "flow.address_reply", { id, text: id === "t1" ? "Switched to a cursor stream in batches of 5k rows; memory stays flat on the 2M-row fixture." : "Named it EXPORT_QUEUE.", sha: "a1b2c3d", posted: true }));
    if (!left.length) later(2300, () => record("X", "flow.address_done", { summary: "2 threads fixed in 2 commits", pushed: false, next: [{ label: "Push and re-request review from @dana", reply: "Push the fixes and re-request review from @dana." }, { label: "Show me the diff", reply: "Show me the diff of the fixes." }] }));
    later(2400, () => sdk(sid, { type: "result", is_error: false, result: "addressed", total_cost_usd: 0.04 }));
    return true;
  }
  return false;
}

// ?fail=1: every call that can fail does, with the raw text real tools print (MR-52 walk).
const FAIL = new URLSearchParams(location.search).has("fail");
// `&signin=fail`: the first sign-in doesn't take (the browser closed), the next one does.
let signInFails = new URLSearchParams(location.search).get("signin") === "fail" ? 1 : 0;
const RAW: Record<string, string> = {
  gh_prs: "To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.",
  session_changes: "warning: Not a git repository. Use --no-index to compare two paths outside a working tree\nusage: git diff --no-index [<options>] <path> <path>\n\nDiff output format options\n    -p, --patch           generate patch",
  session_diff: "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'",
  recent_folders: "No such file or directory (os error 2)",
  folder_create: "couldn't create ~/x: Permission denied (os error 13)",
  daily_driver: "database is locked",
  personal_history: "fatal: invalid reference: main\nhint: ...",
  selfbuild_start: "error[E0425]: cannot find value `x` in this scope\n --> src/lib.rs:3:5\n  |\n3 |     x\n  |     ^ not found in this scope",
  fix_apply: "merge conflict, nothing applied: CONFLICT (content): Merge conflict in ui/src/screens/Wall.tsx\nAutomatic merge failed; fix conflicts and then commit the result.",
  session_send: "unknown session",
};

let drawnN = 1;
function handle(cmd: string, a: Record<string, unknown> = {}): unknown {
  if (FAIL && RAW[cmd]) throw new Error(RAW[cmd]);
  switch (cmd) {
    case "events_list": return events;
    case "events_session": return events.filter((e) => e.session_id === a.sessionId || e.session_id === null);
    case "event_append": return record((a.sessionId as string) ?? null, String(a.kind), (a.payload as Record<string, unknown>) ?? {}).id;
    // Feature usage (MR-83): kept in memory, aggregated like the core's usage_report.
    case "usage_track": usage.push(...((a.items as typeof usage) ?? [])); return null;
    case "usage_report": {
      const m = new Map<string, { kind: string; name: string; detail: string; count: number; total: number; last_at: number }>();
      const add = (kind: string, name: string, detail: string, at: number) => { const k = `${kind}|${name}|${detail}`; const r = m.get(k) ?? { kind, name, detail, count: 0, total: 0, last_at: 0 }; r.total++; if (at >= Number(a.since ?? 0)) r.count++; r.last_at = Math.max(r.last_at, at); m.set(k, r); };
      for (const u of usage) add(u.kind, u.name, u.detail, u.at);
      for (const e of events) if (e.kind.startsWith("ui.")) add("action", e.kind.slice(3), "", e.created_at);
      return [...m.values()];
    }
    case "docs_list": return structuredClone(docs); // the real core serializes over IPC
    case "doc_archive": {
      const d = docs.find((x) => x.id === a.docId);
      if (!d) throw new Error("no such doc");
      docs = docs.filter((x) => x !== d);
      record(d.session_id, a.outcome === "done" ? "ui.doc_done" : a.outcome === "dropped" ? "ui.doc_dropped" : "ui.doc_archived", { doc_id: d.id, title: d.title });
      return null;
    }
    case "doc_check_shipped": return !!docs.find((x) => x.id === a.docId)?.shipped_at; // no git here
    case "doc_mark_shipped": {
      const d = docs.find((x) => x.id === a.docId);
      if (!d) throw new Error("no such doc");
      d.shipped_at = Date.now(); docs = [...docs];
      record(d.session_id, "ui.doc_shipped", { doc_id: d.id, title: d.title });
      return null;
    }
    case "doc_build_started": {
      const d = docs.find((x) => x.id === a.docId);
      if (!d) throw new Error("no such doc");
      const sid = String(a.sessionId);
      if (!d.build_sessions?.includes(sid)) d.build_sessions = [...(d.build_sessions ?? []), sid];
      docs = [...docs];
      record(sid, "ui.doc_build_started", { doc_id: d.id, title: d.title });
      return null;
    }
    case "doc_feedback": {
      const d = docs.find((x) => x.id === a.docId);
      if (!d) throw new Error("no such doc");
      const n = d.pending_notes.length + d.pending_changes.length;
      d.pending_notes = []; d.pending_changes = []; d.version += 1; docs = [...docs];
      void emit("mr-event", { id: id(), session_id: d.session_id, kind: "doc.updated", payload: { doc_id: d.id }, anchor: null, created_at: Date.now() });
      if (a.regenerate) later(1500, () => {
        // The plan session rewrites a block for the new version.
        const b = d.blocks.b2;
        if (b) { d.blocks.b2 = { ...b, was: b.takeaway, takeaway: "Invoices, line items and credit notes; payments stay out of v1.", since: d.version }; docs = [...docs]; }
        void emit("mr-event", { id: id(), session_id: d.session_id, kind: "doc.block_set", payload: { doc_id: d.id }, anchor: null, created_at: Date.now() });
      });
      // Like the real core: build the message only; the UI delivers it to the session.
      return `Feedback on working doc "${d.title}": ${n} note${n === 1 ? "" : "s"}${a.regenerate ? ", regenerate it" : ""}.`;
    }
    // Catch me up (MR-116): a brief doc that fills in block by block, like the session writing it.
    case "brief_start": {
      const sid = String(a.session);
      const did = `doc_brief${Date.now().toString(36)}`;
      const blk = (bid: string, section: string, takeaway: string, key: string, body: string, order: number, view: unknown[], data: Doc["blocks"][string]["data"] = null) =>
        ({ id: bid, section, status: "", takeaway, key, body, data, order, decision: null, updated: "", view: view as never });
      // The brief matches the session it's for (MR-139): the finished settings refactor, else the login fix.
      const settings = sid === "D";
      docs = [...docs, { id: did, title: settings ? "Catch-up: Refactor the settings schema" : "Catch-up: Fix the login redirect loop", session_id: sid, version: 1, kind: "brief", blocks: {}, pending_notes: [], pending_changes: [] }];
      record(sid, "doc.created", { doc_id: did, title: "Catch-up", kind: "brief" });
      const steps: Doc["blocks"][string][] = settings ? [
        blk("where", "goal", "Settings refactor: all 4 steps done, ready to review", "Asked: one typed schema for settings", "Original ask [D01]: replace ad-hoc settings reads with one typed schema. Plan: 4 of 4 done.", 1, [{ type: "progress", n: 4, total: 4, label: "Ready to review" }]),
        blk("done", "log", "Typed schema with defaults; three readers migrated", "2 files changed: schema.ts (new), read.ts", "- `src/settings/schema.ts` new zod schema with defaults\n- `src/settings/read.ts` parses through it; v1 files upgraded on read\n- No commit yet", 2, [{ type: "takeaway", heading: "Done", items: [{ title: "Typed schema with defaults", state: "done" }, { title: "Readers migrated", state: "done" }, { title: "Tests", state: "todo" }] }]),
        blk("next", "design", "Next: run the tests, then open a PR", "Nothing is running now", "The session finished its turn and is waiting for you.", 3, [{ type: "steps", items: [{ text: "Run bun test" }, { text: "Open a PR" }] }]),
        blk("q_1", "question", "Keep reading v1 settings files for one release?", "Claude assumed: upgrade them on read, forever", "Never asked; read.ts upgrades every v1 file silently.", 4, [], { options: [{ label: "One release, then drop", description: "Smaller code later" }, { label: "Forever", description: "As Claude did" }] }),
        blk("risk_1", "risk", "\"All 211 tests pass\", but no test ran", "Not verified: the log has no test command", "The recap says all 211 tests pass. No test command appears anywhere in this session.", 5, [{ type: "risks", items: [{ risk: "Unverified done", mitigation: "Run bun test before the PR", level: "high" }] }]),
        blk("risk_2", "risk", "Old desktop builds can't read the new format", "Claude flagged it; nothing handles it", "Settings written by this build break older desktop builds that sync the same file.", 6, [{ type: "risks", items: [{ risk: "Older builds break on v2 files", mitigation: "Write v1 alongside for one release", level: "medium" }] }]),
      ] : [
        blk("where", "goal", "Fixing the login redirect loop: step 3 of 4, running the tests", "Asked: stop /login bouncing after OAuth", "Original ask [D01]: stop the redirect loop. Current step: Run the tests (plan).", 1, [{ type: "progress", n: 3, total: 4, label: "Run the tests" }]),
        blk("done", "log", "Route guard moved before render; regression test added", "1 file changed: src/app/routes.ts", "- `src/app/routes.ts:10` guard now checks `req.session?.user`\n- No commit yet", 2, [{ type: "takeaway", heading: "Done", items: [{ title: "Guard runs before render", state: "done" }, { title: "Regression test", state: "done" }, { title: "Commit", state: "todo" }] }]),
        blk("next", "design", "Next: run bun test, then commit", "Waiting on your OK to run the tests", "Claude asked to run `bun test` and is waiting on the permission.", 3, [{ type: "steps", items: [{ text: "Run bun test" }, { text: "Commit the fix" }] }]),
        blk("q_1", "question", "Keep the duplicate session refresh in the header?", "Claude assumed: remove it", "Never asked; removed in the same edit.", 4, [], { options: [{ label: "Remove it", description: "As Claude did" }, { label: "Keep it", description: "Revert that part" }] }),
        blk("risk_1", "risk", "\"All tests pass\" with no test run in the log", "Not verified: bun test never ran", "The recap claims 142 tests pass, but the only test command is still waiting on permission.", 5, [{ type: "risks", items: [{ risk: "Unverified done", mitigation: "Run bun test before committing", level: "high" }] }]),
        blk("risk_2", "risk", "Header change goes beyond the ask", "Drift: the ask was the redirect loop only", "Removing the session refresh in the header wasn't asked for.", 6, [{ type: "risks", items: [{ risk: "Drift from the ask", mitigation: "Confirm or revert", level: "medium" }] }]),
      ];
      steps.forEach((b, i) => later(400 + i * 350, () => {
        const d = docs.find((x) => x.id === did);
        if (d) { d.blocks[b.id] = b; docs = [...docs]; }
        void emit("mr-event", { id: id(), session_id: sid, kind: "doc.block_set", payload: { doc_id: did }, anchor: null, created_at: Date.now() });
      }));
      return { doc_id: did, via: "session" };
    }
    case "brief_continue": {
      const d = docs.find((x) => x.id === a.docId);
      if (!d) throw new Error("no such doc");
      const n = d.pending_notes.length + d.pending_changes.length;
      d.pending_notes = []; d.pending_changes = []; docs = [...docs];
      record(d.session_id, "ui.brief_continued", { doc_id: d.id, silent: n === 0 });
      return n ? `The user caught up on this session with the brief "${d.title}". Carry out their decisions, take their corrections, then resume from where you stopped.` : null;
    }
    case "session_start": {
      const sid = (a.sessionId as string) ?? `s${Date.now().toString(36)}`;
      const cwd = String(a.cwd ?? "~/");
      const repo = cwd.startsWith("~") ? null : cwd;
      const slug = String(a.prompt ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24);
      record(sid, "ui.session_requested", { cwd, prompt: a.prompt, kind: a.kind ?? "blank", resume: a.resume ?? null, workspace: a.workspace ?? "personal", ...(a.preset ? { preset: a.preset } : {}), ...(repo && (a.worktree ?? a.kind === "blank") ? { repo, branch: `mr/${slug}`, worktree: `${repo}-worktrees/${slug}` } : {}) });
      runAgent(sid, String(a.prompt ?? ""));
      return sid;
    }
    // Recurring sessions (MR-167): logged like the core; Run now starts a scripted session tagged ↻.
    case "schedule_set": {
      const d = (a.schedule as Record<string, unknown>) ?? {};
      const mode = d.mode ?? "prompt";
      if (mode !== "prompt" && mode !== "review") throw `unknown mode: ${String(mode)} (prompt or review)`;
      if (!String(d.name ?? "").trim() || (mode === "prompt" && !String(d.prompt ?? "").trim())) throw "give it a name and a prompt";
      if (mode === "review" && !handle("gh_repo", { cwd: d.cwd })) throw `review mode needs a GitHub repo: ${String(d.cwd)} has no github.com origin`;
      const id = (d.id as string) || `sch${Date.now().toString(36)}`;
      record(null, "ui.schedule_set", { ...d, id, mode, workspace: d.workspace ?? "personal", permission_mode: d.permission_mode ?? "auto", paused: d.paused ?? false });
      return id;
    }
    case "schedule_delete": record(null, "ui.schedule_deleted", { id: a.id }); return null;
    case "schedules_next": {
      const out: Record<string, number> = {};
      for (const e of events) if (e.kind === "ui.schedule_set") out[String(e.payload.id)] = Date.now() + 3_600_000;
      for (const e of events) if (e.kind === "ui.schedule_deleted" || (e.kind === "ui.schedule_set" && e.payload.paused)) delete out[String(e.payload.id)];
      return out;
    }
    // MR-169: the next runs come from the same expressions; a gated schedule looks checked a minute ago.
    case "schedule_preview": {
      const c = a.cadence as Cadence;
      const next = nextRuns(cadenceExpr(c), Date.now());
      if (!next.length) throw "that never runs";
      return next;
    }
    case "schedules_checks": {
      const out: Record<string, unknown> = {};
      for (const e of events) if (e.kind === "ui.schedule_set") { if (e.payload.mode === "review") out[String(e.payload.id)] = { at: Date.now() - 60_000, outcome: "nothing", skipped: 3, error: null, waiting: 0 }; else if (e.payload.check) out[String(e.payload.id)] = { at: Date.now() - 60_000, outcome: "same", skipped: 7, error: null }; else delete out[String(e.payload.id)]; }
      return out;
    }
    case "schedule_run_now": {
      const set = [...events].reverse().find((e) => e.kind === "ui.schedule_set" && e.payload.id === a.id);
      if (!set) throw "that schedule was deleted";
      // MR-171: review mode lists the repo's PRs and starts a Review for each head not started yet.
      if (set.payload.mode === "review") {
        const repo = handle("gh_repo", { cwd: set.payload.cwd }) as string | null;
        if (!repo) throw `${String(set.payload.cwd)} isn't a GitHub repo (no github.com origin)`;
        const prs = handle("gh_prs", { cwd: set.payload.cwd, mode: "review", repo }) as { number: number; title: string; url: string }[];
        const done = new Set(events.filter((e) => e.kind === "schedule.review_started" || e.kind === "ui.auto_review_started").map((e) => `${e.payload.url}@${e.payload.head ?? ""}`));
        const todo = prs.filter((p) => !done.has(`${p.url}@h${p.number}`));
        record(null, "schedule.fired", { id: a.id, mode: "review", reason: "manual", new: todo.length });
        const ids = todo.map((p, i) => {
          const sid = `s${Date.now().toString(36)}${i}`;
          record(sid, "ui.session_requested", { cwd: set.payload.cwd, prompt: `/review ${p.url}`, kind: "review", resume: null, workspace: set.payload.workspace ?? "personal", schedule: a.id });
          record(sid, "schedule.review_started", { id: a.id, url: p.url, number: p.number, title: p.title, head: `h${p.number}`, session: sid });
          return sid;
        });
        return ids[0] ?? "";
      }
      const sid = `s${Date.now().toString(36)}`;
      record(sid, "ui.session_requested", { cwd: set.payload.cwd, prompt: set.payload.prompt, kind: "blank", resume: null, workspace: set.payload.workspace ?? "personal", schedule: a.id });
      record(sid, "schedule.fired", { id: a.id, session: sid, reason: "manual" });
      runAgent(sid, String(set.payload.prompt ?? ""));
      return sid;
    }
    case "background_set": record(null, "ui.background_set", { mode: a.mode }); return null;
    case "session_send": {
      const sid = String(a.session), text = String(a.text);
      record(sid, "ui.message_sent", { text });
      if (scripted(sid, text)) return null;
      // Like Claude Code (MR-59): mid-tool, a message waits for that tool's result before Claude reads it.
      const last = [...events].reverse().find((e) => e.session_id === sid && e.kind === "sidecar.sdk")?.payload.message as { type?: string; message?: { content?: { type: string; id?: string }[] } } | undefined;
      const open = last?.type === "assistant" ? last.message?.content?.find((c) => c.type === "tool_use")?.id : undefined;
      const wait = open ? 4000 : 0;
      if (open) later(wait, () => sdk(sid, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: open, content: "ok" }] } }));
      later(wait + 1500, () => sdk(sid, { type: "assistant", message: { content: [{ type: "text", text: `Got it: ${text.slice(0, 80)}. Working on it.` }] } }));
      later(wait + 4000, () => sdk(sid, { type: "result", is_error: false, result: "ok", total_cost_usd: 0.05 }));
      return null;
    }
    case "permission_respond": {
      const allowed = (a.decision as { behavior?: string })?.behavior === "allow";
      record(String(a.session), "ui.permission_answered", { request_id: a.requestId, decision: a.decision });
      finishAgent(String(a.session), allowed);
      return null;
    }
    case "session_interrupt": record(String(a.session), "sidecar.sdk", { message: { type: "result", is_error: true, result: "interrupted" } }); return null;
    case "session_set_model": {
      const c = a.change as Record<string, unknown>;
      record(String(a.session), "ui.model_set", c);
      later(300, () => record(String(a.session), "sidecar.model_set", { ...c, ok: true }));
      return null;
    }
    // Slash commands and /mcp (MR-87), like the sidecar answers them.
    case "session_commands": later(200, () => record(String(a.session), "sidecar.commands", { commands: DEMO_COMMANDS })); return null;
    case "session_mcp_status": later(300, () => record(String(a.session), "sidecar.mcp_status", { servers: demoMcp })); return null;
    case "session_mcp_action": {
      const server = String(a.server), action = String(a.action);
      record(String(a.session), "ui.mcp_action", { server, action });
      const x = demoMcp.find((m) => m.name === server);
      if (x && action !== "reconnect") x.status = action === "enable" ? "connected" : "disabled";
      const ok = !(x?.status === "failed" && action === "reconnect");
      later(900, () => record(String(a.session), "sidecar.mcp_status", { servers: demoMcp, done: { server, action, ok, ...(ok ? {} : { error: "connection refused (localhost:4100)" }) } }));
      return null;
    }
    case "session_mcp_add": {
      const server = String(a.server), config = a.config as { type: string; url?: string };
      record(String(a.session), "ui.mcp_action", { server, action: "add", scope: a.scope, transport: config.type });
      const ok = !demoMcp.some((m) => m.name === server);
      if (ok) demoMcp.push({ name: server, status: "connected", source: "dynamic", scope: null, error: null, version: null, url: config.url ?? null, tools: ["search", "fetch"] });
      later(900, () => record(String(a.session), "sidecar.mcp_status", { servers: demoMcp, done: { server, action: "add", ok, ...(ok ? {} : { error: `MCP server ${server} already exists in local config` }) } }));
      return null;
    }
    // A drawn-on copy (MR-143): the demo has no disk, so it only names where the core would put it.
    case "attachment_save": { const n = drawnN++; return { path: `/Users/me/Library/Application Support/Cockpit/attachments/demo${n}-drawn.png`, name: `drawn-${n}.png`, mime: "image/png", size: a instanceof Uint8Array ? a.length : 0 }; }
    case "models_refresh": record(null, "sidecar.models", { models: DEMO_MODELS }); return null;
    case "session_stop": record(String(a.session), "sidecar.session_ended", { ok: true }); return null;
    // Signed back in (MR-153): the real core restarts the session first; here the message just goes again.
    case "session_retry_signed_in": record(String(a.session), "ui.relogin_restart", {}); return handle("session_send", a);
    case "session_changes": return [
      { path: "src/app/routes.ts", added: 24, removed: 9, status: "M", risky: null },
      { path: "src/auth/session.ts", added: 11, removed: 30, status: "M", risky: "auth" },
      { path: "src/app/routes.test.ts", added: 58, removed: 0, status: "A", risky: null },
      { path: "migrations/0042_sessions.sql", added: 7, removed: 0, status: "A", risky: "migration" },
    ];
    case "task_output": return `$ bun run build:all\n[billing-core] compiled 212 modules in 4.1s\n[billing-api] compiled 88 modules in 2.3s\n[billing-web] building… ${new Date().toLocaleTimeString()}`;
    case "run_command": {
      const id = `run${Date.now().toString(36)}`;
      record(String(a.session), "ui.run_started", { run_id: id, command: a.command, cwd: a.cwd });
      later(/sleep|watch|dev/.test(String(a.command)) ? 60_000 : 2500, () => { if (!events.some((e) => e.kind === "run.finished" && e.payload.run_id === id)) record(String(a.session), "run.finished", { run_id: id, code: /lint/.test(String(a.command)) ? 1 : 0, status: /lint/.test(String(a.command)) ? "failed" : "completed" }); });
      return id;
    }
    case "run_stop": record(String(a.session), "ui.run_stopped", { run_id: a.runId }); record(String(a.session), "run.finished", { run_id: a.runId, code: null, status: "stopped" }); return null;
    case "run_output": return `$ ${events.find((e) => e.kind === "ui.run_started" && e.payload.run_id === a.runId)?.payload.command ?? "…"}\nsrc/invoice.ts:12:1  error  Imports must be sorted  import/order\n\n1 problem (1 error, 0 warnings)`;
    case "session_diff": return `--- a/${a.path}\n+++ b/${a.path}\n@@ -10,6 +10,9 @@\n export function guard(req) {\n-  if (!req.session) return redirect("/login");\n+  if (!req.session?.user) {\n+    return redirect(\`/login?next=\${encodeURIComponent(req.url)}\`);\n+  }\n   return next();\n }`;
    case "recent_folders": return [
      { path: "/Users/me/code/shop", name: "shop", repo: true, at: 0 },
      { path: "/Users/me/code/billing", name: "billing", repo: true, at: 0 },
      { path: "/Users/me/code/cockpit", name: "cockpit", repo: true, at: 0 },
      { path: "/Users/me/notes", name: "notes", repo: false, at: 0 },
    ];
    case "folder_exists": return /^(~|\/Users\/me)(\/(code(\/(shop|billing|cockpit))?|notes))?$/.test(String(a.path));
    case "folder_create": return String(a.path).replace(/^~/, "/Users/me");
    // Watched repos (MR-170): validated and logged like the core's auto_review_repos_set.
    case "auto_review_repos_set": {
      const repos = ((a.repos as string[]) ?? []).map((r) => { const s = watchSlug(r); if (!s) throw new Error(`not a GitHub repo (owner/name): ${r}`); return s; })
        .filter((r, i, all) => all.findIndex((x) => x.toLowerCase() === r.toLowerCase()) === i);
      record(null, "ui.auto_review_repos_set", { repos });
      return repos;
    }
    case "gh_repo": return /shop|billing|cockpit/.test(String(a.cwd)) ? `acme/${String(a.cwd).split("/").pop()}` : null;
    case "gh_prs": if (a.repo && a.mode === "review") return [
      { number: 491, title: "Checkout: idempotent order ids", url: `https://github.com/${a.repo}/pull/491`, updatedAt: new Date().toISOString(), author: { login: "sam" }, repository: { nameWithOwner: a.repo }, reviewNote: "new changes since your review" },
      { number: 495, title: "Cart: keep items across devices", url: `https://github.com/${a.repo}/pull/495`, updatedAt: new Date().toISOString(), author: { login: "dana" }, repository: { nameWithOwner: a.repo }, reviewNote: "not reviewed yet" }];
      if (a.repo) return (handle("gh_prs", { ...a, repo: undefined }) as { repository: { nameWithOwner: string } }[]).filter((p) => p.repository.nameWithOwner === a.repo);
      return a.mode === "review"
      ? [{ number: 482, title: "Checkout: retry failed payments", url: "https://github.com/acme/shop/pull/482", updatedAt: new Date().toISOString(), author: { login: "dana" }, repository: { nameWithOwner: "acme/shop" } }]
      : [{ number: 479, title: "Billing CSV export", url: "https://github.com/acme/billing/pull/479", updatedAt: new Date().toISOString(), repository: { nameWithOwner: "acme/billing" }, reviewDecision: "CHANGES_REQUESTED", unresolved: 3, waiting: 2 },
        { number: 486, title: "Invoices: tax line per country", url: "https://github.com/acme/billing/pull/486", updatedAt: new Date().toISOString(), repository: { nameWithOwner: "acme/billing" }, unresolved: 1, waiting: 1 },
        { number: 490, title: "Shop: faster search index", url: "https://github.com/acme/shop/pull/490", updatedAt: new Date().toISOString(), repository: { nameWithOwner: "acme/shop" }, unresolved: 0, waiting: 0 }];
    case "daily_driver": return { streak: 2, goal: 7 };
    case "selfbuild_list": return [];
    case "personal_history": return { worktree: "/Users/me/code/cockpit-worktrees/mine", changes: events.some((e) => e.kind === "ui.fix_applied") ? [{ sha: "a1b2c3d4", subject: "Fix: change box hides git's usage text", at: Date.now(), mine_only: true }] : [], pending: [] };
    case "app_repo_path": return "/Users/me/code/cockpit";
    // One-click Update (MR-66): ?demo=busy&update=1 offers two updates; &update=fail fails the build.
    case "update_status": {
      const u = new URLSearchParams(location.search).get("update");
      const applied = events.some((e) => e.kind === "app.started" && events.some((r) => r.kind === "update.restarting"));
      return { mode: "ready", pending: u && !applied ? [{ sha: "a1b2c3d", subject: "Live titles, rename, dynamic next steps" }, { sha: "d4e5f6a", subject: "Plan panel with progress" }] : [] };
    }
    case "update_start": {
      const fail = new URLSearchParams(location.search).get("update") === "fail";
      record(null, "update.started", { to: "d4e5f6a", subjects: ["Live titles, rename, dynamic next steps", "Plan panel with progress"] });
      record(null, "update.step", { step: "sidecar" });
      later(2500, () => record(null, "update.step", { step: "app" }));
      later(6000, () => record(null, "update.finished", fail ? { ok: false, step: "app", log: "error[E0425]: cannot find value `slot` in this scope\n  --> src/update.rs:88:41" } : { ok: true, seconds: 6 }));
      return null;
    }
    case "update_restart": record(null, "update.restarting", { subjects: ["Live titles, rename, dynamic next steps", "Plan panel with progress"] }); later(1200, () => record(null, "app.started", { sha: "d4e5f6a" })); return null;
    // Release updates (MR-136): ?demo=busy&release=available|ready|conflicts|failed.
    case "release_status": {
      const r = new URLSearchParams(location.search).get("release");
      const chose = events.some((e) => e.kind === "ui.release_choice" || e.kind === "ui.release_install");
      const phase = r && !chose ? r : "idle";
      return { mode: r === "available" ? "swap" : "merge", phase, version: "0.2.0", notes: "Auto-update from GitHub releases", updated: null,
        preview: phase === "ready" ? { yours: 3, brings: 12, conflicts: [] } : phase === "conflicts" ? { yours: 3, brings: 12, conflicts: ["ui/src/screens/Wall.tsx", "src-tauri/src/sidecar.rs"] } : null,
        failure: phase === "failed" ? { stage: "build", log: "error[E0308]: mismatched types\n  --> src/sidecar.rs:120:9" } : null };
    }
    case "release_install": record(null, "ui.release_install", {}); return null;
    case "release_choose": record(null, "ui.release_choice", { choice: a.choice }); return a.choice === "plan" ? { cwd: "/Users/me/code/cockpit-worktrees/mine", prompt: "Plan the release merge" } : null;
    case "release_check": case "release_seen": return null;
    case "layer2_status": return { configured: false };
    case "layer2_classify": {
      const label = /\?\s*$/.test(String(a.text).trim()) ? "question" : "other";
      const payload = { item_id: a.itemId, label, p: 1, layer: "code", dist: null, ms: 0, tokens: 0, error: null };
      record(String(a.session), "picker.layer2", payload);
      return payload;
    }
    case "layer3_diagram":
      later(1200, () => record(String(a.session), "picker.layer3", { item_id: a.itemId, diagram: diagramFor(String(a.text)), ms: 1200, error: null }));
      return null;
    case "limits_refresh": record(null, "sidecar.limits", { available: true, plan: "max", five_hour: { utilization: 0.34, resetsAt: Math.round(Date.now() / 1000) + 7200 }, seven_day: { utilization: 0.58, resetsAt: null } }); return null;
    case "godmode_save_mark": return "/Users/me/code/cockpit";
    case "personal_sync": return "";
    case "pr_repo": return String(a.spec).includes("acme/shop") ? "/Users/me/code/shop" : null;
    case "fix_apply": record(String(a.session), "ui.fix_applied", { branch: "mr/god-mode-mark-ab12" }); return "merged";
    case "plugin:dialog|open": return "/Users/me/code/picked-folder";
    // A scripted `claude auth login`: prints, then exits by itself like the real one does.
    case "workspace_sign_in": {
      const key = `login:${a.id}`;
      later(100, () => void emit("term-data", { session: key, data: "Opening browser to sign in…\r\n" }));
      later(900, () => void emit("term-exit", { session: key }));
      return key;
    }
    case "workspace_auth_status": { const ok = signInFails === 0; signInFails = Math.max(0, signInFails - 1); record(null, "ui.sign_in_checked", { workspace: a.id, signed_in: ok }); return ok; }
    case "term_open": case "voice_start": throw new Error("Not available in the demo (needs the desktop app).");
    case "workspace_create": { const wid = `ws_${Date.now().toString(36)}`; record(null, "ui.workspace_created", { id: wid, name: a.name, config_dir: `/demo/${wid}` }); return wid; }
    case "workspace_delete": record(null, "ui.workspace_deleted", { id: a.id, name: a.name, stopped: 0, trashed_to: "~/.Trash/…" }); return null;
    case "workspace_set_folder": record(null, "ui.workspace_folder_set", { id: a.id, folder: a.folder ?? null }); return null;
    case "workspace_rename": record(null, "ui.workspace_renamed", { id: a.id, name: a.name }); return null;
    case "session_move": record(String(a.session), "ui.session_moved", { from: "personal", to: a.workspace, copied: 1 }); return null;
    case "workspace_reorder": record(null, "ui.workspaces_reordered", { order: a.order }); return null;
    case "overview_tidy": record(null, "ui.overview_tidied", {}); return null;
    case "overview_move": record(null, "ui.overview_moved", { workspace: a.workspace, x: Math.round(Number(a.x)), y: Math.round(Number(a.y)) }); return null;
    default: return null;
  }
}

export function install(name: string) {
  const sc: Scenario = SCENARIOS[name] ?? SCENARIOS.busy;
  // Each load starts clean: remembered UI choices (start-picker kind, workspace, folder) would
  // otherwise carry from one scenario into the next and make it depend on what ran before.
  try { for (const k of Object.keys(localStorage)) if (k.startsWith("mr.")) localStorage.removeItem(k); } catch { /* no storage */ }
  if (new URLSearchParams(location.search).get("motion") === "off") document.documentElement.dataset.motion = "off";
  const base = Date.now() - 40 * 60_000;
  docs = structuredClone(sc.docs);
  for (const [i, e] of sc.events.entries()) {
    events.push({ id: id(), session_id: e.session ?? null, kind: e.kind, payload: e.payload ?? {}, anchor: null, created_at: base + (e.at ?? i) * 1000 });
    applyDocEvent(events[events.length - 1]);
  }
  mockIPC((cmd, args) => {
    try { return handle(cmd, args as Record<string, unknown>); } catch (e) { return Promise.reject(String(e instanceof Error ? e.message : e)); }
  }, { shouldMockEvents: true });
  // Expose for scripted walkthroughs (e.g. advancing an agent from the browser console).
  (window as unknown as { __mrDemo: unknown }).__mrDemo = { events, record, scenario: name };
}

// What Claude Code offers a Max login, for the model picker (MR-73).
const DEMO_COMMANDS = [
  { name: "mcp", description: "Manage MCP servers", hint: "", aliases: [], builtin: true, skill: false, terminal: false },
  { name: "model", description: "Set the AI model for Claude Code", hint: "[model]", aliases: [], builtin: true, skill: false, terminal: false },
  { name: "compact", description: "Clear conversation history but keep a summary in context", hint: "<instructions>", aliases: [], builtin: true, skill: false, terminal: false },
  { name: "context", description: "Show current context usage", hint: "", aliases: [], builtin: true, skill: false, terminal: false },
  { name: "doctor", description: "Diagnose and verify your Claude Code installation", hint: "", aliases: [], builtin: true, skill: false, terminal: true },
  { name: "usage", description: "Show plan usage limits", hint: "", aliases: ["cost"], builtin: true, skill: false, terminal: false },
  { name: "review", description: "Review a PR or branch: accepts a branch name or GitHub PR URL", hint: "<pr>", aliases: [], builtin: false, skill: true, terminal: false },
  { name: "mr-task", description: "Run one Cockpit task end to end", hint: "<task>", aliases: [], builtin: false, skill: true, terminal: false },
  { name: "agent-skills:test", description: "Run TDD workflow: write failing tests, implement, verify", hint: "", aliases: [], builtin: false, skill: true, terminal: false },
  { name: "pinchtab", description: "Browser automation through PinchTab", hint: "", aliases: [], builtin: false, skill: true, terminal: false },
];
const demoMcp: McpServer[] = [
  { name: "claude.ai Slack", status: "connected", source: "claudeai", scope: "claudeai", error: null, version: "1.4.0", url: null, tools: ["slack_send_message", "slack_read_channel", "slack_search_public", "slack_read_thread"] },
  { name: "claude.ai Gmail", status: "needs-auth", source: "claudeai", scope: "claudeai", error: null, version: null, url: null, tools: [] },
  { name: "linear", status: "failed", source: "user", scope: "user", error: "connection refused (localhost:4100)", version: null, url: "http://localhost:4100/mcp", tools: [] },
  { name: "figma", status: "disabled", source: "plugin", scope: "user", error: null, version: null, url: null, tools: [] },
  { name: "mr", status: "connected", source: "sdk", scope: null, error: null, version: null, url: null, tools: ["plan_set"] },
];
const DEMO_MODELS = [
  { value: "default", resolved: "claude-opus-5-5", displayName: "Default (recommended)", description: "Opus 5.5 with 1M context · most capable", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { value: "sonnet", resolved: "claude-sonnet-5-5", displayName: "Sonnet", description: "Sonnet 5.5 · everyday tasks", efforts: ["low", "medium", "high"] },
  { value: "haiku", resolved: "claude-haiku-5-5", displayName: "Haiku", description: "Haiku 5.5 · fastest for quick answers", efforts: [] },
];
