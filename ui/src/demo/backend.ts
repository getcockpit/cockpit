// Demo backend (MR-40): the UI running in a plain browser against a scripted fake core, so every
// job-to-be-done flow can be walked, screenshotted and judged without Tauri, Claude or usage.
// Open http://localhost:1420/?demo=<scenario> (see scenarios.ts). Never loaded inside the app.

import { mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { MrEvent } from "../state/types";
import type { Doc } from "../state/docs";
import { REVIEW_SNIPPETS, SCENARIOS, type Scenario } from "./scenarios";

let seq = 0;
const events: MrEvent[] = [];
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
  if (ev.kind === "ui.doc_decision" && b) b.decision = p.choice;
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
  later(2600, () => sdk(session, { type: "assistant", message: { content: [{ type: "tool_use", id: "t3", name: "TodoWrite", input: { todos: todos(1) } }, { type: "tool_use", id: "t4", name: "Edit", input: { file_path: "src/app/routes.ts", old_string: "a\nb", new_string: "a\nb\nc\nd" } }] } }));
  later(3600, () => sdk(session, { type: "assistant", message: { content: [{ type: "tool_use", id: "t5", name: "TodoWrite", input: { todos: todos(2) } }] } }));
  later(4000, () => record(session, "sidecar.permission_request", { request_id: `p-${session}`, tool: "Bash", input: { command: "bun test", description: "Run the test suite" }, suggestions: null, decision_reason: null }));
}

function finishAgent(session: string, allowed: boolean) {
  const recap = allowed
    ? "Done. Here's what changed:\n1. Moved the redirect check into the route guard so it runs before render.\n2. Added a regression test for the OAuth callback path.\n3. Removed the duplicate session refresh in the header.\n4. All 142 tests pass.\nWant me to open a PR, or keep going on the follow-ups?"
    : "Okay, I didn't run the tests. The change is in src/app/routes.ts. Should I run a narrower test file instead?";
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
    const shown = events.filter((e) => e.session_id === "R" && e.kind === "flow.review_snippet").length;
    if (text === "next" && shown < REVIEW_SNIPPETS.length) { later(500, () => record("R", "flow.review_snippet", REVIEW_SNIPPETS[shown])); done("snippet"); return true; }
    if (text === "next") {
      const noted = events.filter((e) => e.session_id === "R" && e.kind === "ui.review_noted").map((e) => String(e.payload.finding_id));
      const all = REVIEW_SNIPPETS.flatMap((x) => x.findings);
      later(500, () => record("R", "flow.review_publish_ready", { comments: all.filter((f) => noted.includes(f.id)).map((f) => ({ severity: f.severity, at: f.at, text: f.text })), verdict: noted.length ? "Request changes" : "Approve", dropped: 0 }));
      done("ready"); return true;
    }
    if (text === "publish") { later(500, () => sdk(sid, { type: "assistant", message: { content: [{ type: "text", text: "Published the review on PR #482." }] } })); done("published"); return true; }
    if (text.startsWith("note ")) { done("noted"); return true; }
    if (text === "ok") { later(1500, () => record("R", "flow.review_snippet", REVIEW_SNIPPETS[0])); later(1700, () => sdk(sid, { type: "result", is_error: false, result: "snippet", total_cost_usd: 0.04 })); return true; }
    if (text.startsWith("Add this to the review") || text.startsWith("About ")) { later(900, () => sdk(sid, { type: "assistant", message: { content: [{ type: "text", text: "Added to your review." }] } })); done("ok"); return true; }
  }
  if (sid === "X" && text.startsWith("Option ")) {
    const cur = [...events].reverse().find((e) => e.session_id === "X" && e.kind === "flow.address_thread")?.payload.id as string;
    later(500, () => record("X", "flow.address_proof", { id: cur, checks: [{ label: "Tests pass", ok: true, proof: "211 passed" }, { label: "Memory stays flat on 2M rows", ok: true, proof: "peak 180 MB" }] }));
    later(900, () => record("X", "flow.address_reply", { id: cur, text: "Switched to a cursor stream in batches of 5k rows; memory stays flat on the 2M-row fixture.", sha: "a1b2c3d", posted: false }));
    if (cur === "t1") later(1300, () => record("X", "flow.address_thread", { id: "t2", reviewer: "dana", at: "export.ts:58", body: "Magic string 'exports' — make it a named constant.", verdict: "Valid, trivial.", evidence_file: "src/export.ts", evidence_code: "queue.add('exports', job)", options: [{ id: "a", label: "Add EXPORT_QUEUE constant", recommended: true }, { id: "b", label: "Push back" }] }));
    done("addressed"); return true;
  }
  return false;
}

// ?fail=1: every call that can fail does, with the raw text real tools print (MR-52 walk).
const FAIL = new URLSearchParams(location.search).has("fail");
const RAW: Record<string, string> = {
  gh_prs: "To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.",
  session_changes: "warning: Not a git repository. Use --no-index to compare two paths outside a working tree\nusage: git diff --no-index [<options>] <path> <path>\n\nDiff output format options\n    -p, --patch           generate patch",
  session_diff: "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'",
  recent_folders: "No such file or directory (os error 2)",
  daily_driver: "database is locked",
  personal_history: "fatal: invalid reference: main\nhint: ...",
  selfbuild_start: "error[E0425]: cannot find value `x` in this scope\n --> src/lib.rs:3:5\n  |\n3 |     x\n  |     ^ not found in this scope",
  fix_apply: "merge conflict, nothing applied: CONFLICT (content): Merge conflict in ui/src/screens/Wall.tsx\nAutomatic merge failed; fix conflicts and then commit the result.",
  session_send: "unknown session",
};

function handle(cmd: string, a: Record<string, unknown> = {}): unknown {
  if (FAIL && RAW[cmd]) throw new Error(RAW[cmd]);
  switch (cmd) {
    case "events_list": return events;
    case "event_append": return record((a.sessionId as string) ?? null, String(a.kind), (a.payload as Record<string, unknown>) ?? {}).id;
    case "docs_list": return structuredClone(docs); // the real core serializes over IPC
    case "doc_archive": {
      const d = docs.find((x) => x.id === a.docId);
      if (!d) throw new Error("no such doc");
      docs = docs.filter((x) => x !== d);
      record(d.session_id, "ui.doc_archived", { doc_id: d.id, title: d.title });
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
    case "session_start": {
      const sid = (a.sessionId as string) ?? `s${Date.now().toString(36)}`;
      const cwd = String(a.cwd ?? "~/");
      const repo = cwd.startsWith("~") ? null : cwd;
      const slug = String(a.prompt ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24);
      record(sid, "ui.session_requested", { cwd, prompt: a.prompt, kind: a.kind ?? "blank", resume: a.resume ?? null, workspace: a.workspace ?? "personal", ...(a.preset ? { preset: a.preset } : {}), ...(repo && (a.worktree ?? a.kind === "blank") ? { repo, branch: `mr/${slug}`, worktree: `${repo}-worktrees/${slug}` } : {}) });
      runAgent(sid, String(a.prompt ?? ""));
      return sid;
    }
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
    case "models_refresh": record(null, "sidecar.models", { models: DEMO_MODELS }); return null;
    case "session_stop": record(String(a.session), "sidecar.session_ended", { ok: true }); return null;
    case "session_changes": return [
      { path: "src/app/routes.ts", added: 24, removed: 9, status: "M", risky: null },
      { path: "src/auth/session.ts", added: 11, removed: 30, status: "M", risky: "auth" },
      { path: "src/app/routes.test.ts", added: 58, removed: 0, status: "A", risky: null },
      { path: "migrations/0042_sessions.sql", added: 7, removed: 0, status: "A", risky: "migration" },
    ];
    case "session_diff": return `--- a/${a.path}\n+++ b/${a.path}\n@@ -10,6 +10,9 @@\n export function guard(req) {\n-  if (!req.session) return redirect("/login");\n+  if (!req.session?.user) {\n+    return redirect(\`/login?next=\${encodeURIComponent(req.url)}\`);\n+  }\n   return next();\n }`;
    case "recent_folders": return [
      { path: "/Users/me/code/shop", name: "shop", repo: true, at: 0 },
      { path: "/Users/me/code/billing", name: "billing", repo: true, at: 0 },
      { path: "/Users/me/code/cockpit", name: "cockpit", repo: true, at: 0 },
      { path: "/Users/me/notes", name: "notes", repo: false, at: 0 },
    ];
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
    case "term_open": case "workspace_sign_in": case "voice_start": throw new Error("Not available in the demo (needs the desktop app).");
    case "workspace_create": { const wid = `ws_${Date.now().toString(36)}`; record(null, "ui.workspace_created", { id: wid, name: a.name, config_dir: `/demo/${wid}` }); return wid; }
    case "workspace_delete": record(null, "ui.workspace_deleted", { id: a.id, name: a.name, stopped: 0, trashed_to: "~/.Trash/…" }); return null;
    case "workspace_set_folder": record(null, "ui.workspace_folder_set", { id: a.id, folder: a.folder ?? null }); return null;
    case "workspace_rename": record(null, "ui.workspace_renamed", { id: a.id, name: a.name }); return null;
    default: return null;
  }
}

export function install(name: string) {
  const sc: Scenario = SCENARIOS[name] ?? SCENARIOS.busy;
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
const DEMO_MODELS = [
  { value: "default", resolved: "claude-opus-5-5", displayName: "Default (recommended)", description: "Opus 5.5 with 1M context · most capable", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { value: "sonnet", resolved: "claude-sonnet-5-5", displayName: "Sonnet", description: "Sonnet 5.5 · everyday tasks", efforts: ["low", "medium", "high"] },
  { value: "haiku", resolved: "claude-haiku-5-5", displayName: "Haiku", description: "Haiku 5.5 · fastest for quick answers", efforts: [] },
];
