import type { Doc } from "../state/docs";

// Demo scenarios (MR-40). Each is an event log the real reducer replays, plus the docs the core
// would have folded. `at` is seconds after a base 40 minutes ago.
type E = { session?: string; kind: string; payload?: Record<string, unknown>; at?: number };
export type Scenario = { events: E[]; docs: Doc[] };

const ready: E[] = [
  { kind: "sidecar.ready", payload: { claude: "/Users/me/.local/bin/claude" }, at: 0 },
  { kind: "sidecar.limits", payload: { available: true, plan: "max", five_hour: { utilization: 0.34, resetsAt: Math.round(Date.now() / 1000) + 7200 }, seven_day: { utilization: 0.58, resetsAt: null } }, at: 1 },
];
const onboarded: E = { kind: "ui.onboarded", at: 2 };

const say = (session: string, text: string, at: number): E => ({ session, kind: "sidecar.sdk", payload: { message: { type: "assistant", message: { content: [{ type: "text", text }] } } }, at });
const tool = (session: string, name: string, input: Record<string, unknown>, at: number, id = `${name}-${at}`): E => ({ session, kind: "sidecar.sdk", payload: { message: { type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } } }, at });
const todos = (session: string, done: number, items: [string, string][], at: number): E => tool(session, "TodoWrite", { todos: items.map(([content, activeForm], i) => ({ content, activeForm, status: i < done ? "completed" : i === done ? "in_progress" : "pending" })) }, at);
const result = (session: string, text: string, at: number, cost = 0.3): E => ({ session, kind: "sidecar.sdk", payload: { message: { type: "result", is_error: false, result: text, total_cost_usd: cost } }, at });
const start = (session: string, prompt: string, extra: Record<string, unknown>, at: number): E[] => [
  { session, kind: "ui.session_requested", payload: { prompt, kind: "blank", workspace: "personal", ...extra }, at },
  { session, kind: "sidecar.session_started", payload: { sdk_session_id: `sdk-${session}`, model: "claude-opus-5-5" }, at: at + 1 },
];

const RECAP = "Refactor is finished. Summary:\n1. Split settings into a typed schema with defaults.\n2. Migrated the three readers to the new accessor.\n3. Added a migration for existing user files.\n4. Risk: old desktop builds can't read the new format.\n5. All 211 tests pass.\nThe branch is mr/settings-schema.";

const busy: E[] = [
  ...ready, onboarded,
  // A: needs a permission (risky command)
  ...start("A", "Fix the login redirect after OAuth", { cwd: "/Users/me/code/shop-worktrees/fix-login", repo: "/Users/me/code/shop", branch: "mr/fix-login" }, 10),
  todos("A", 2, [["Reproduce the redirect loop", "Reproducing the redirect loop"], ["Find the guard", "Finding the guard"], ["Fix the guard", "Fixing the guard"], ["Add a regression test", "Adding a regression test"], ["Push the branch", "Pushing the branch"]], 20),
  tool("A", "Edit", { file_path: "src/auth/session.ts", old_string: "a\nb\nc", new_string: "a\nb\nc\nd\ne" }, 60),
  { session: "A", kind: "sidecar.permission_request", payload: { request_id: "pA", tool: "Bash", input: { command: "git push --force origin mr/fix-login", description: "Force-push the rebased branch" }, suggestions: null, decision_reason: null }, at: 2300 },
  // E: asks a structured question
  ...start("E", "Add rate limiting to the public API", { cwd: "/Users/me/code/shop-worktrees/rate-limit", repo: "/Users/me/code/shop", branch: "mr/rate-limit" }, 30),
  say("E", "I looked at the gateway and the middleware. Two ways to do this.", 200),
  { session: "E", kind: "sidecar.permission_request", payload: { request_id: "pE", tool: "AskUserQuestion", input: { questions: [{ question: "Where should the limiter live?", header: "Limiter", multiSelect: false, options: [{ label: "API gateway", description: "One place, no code change, coarse per-IP limits" }, { label: "App middleware", description: "Per-user limits, needs Redis" }] }] }, suggestions: null, decision_reason: null }, at: 2320 },
  // C: running, almost done
  ...start("C", "Bump dependencies and fix breakages", { cwd: "/Users/me/code/billing-worktrees/deps", repo: "/Users/me/code/billing", branch: "mr/deps" }, 40),
  todos("C", 4, [["Update lockfile", "Updating lockfile"], ["Fix type errors", "Fixing type errors"], ["Fix failing tests", "Fixing failing tests"], ["Update changelog", "Updating changelog"], ["Run the full suite", "Running the full suite"]], 2340),
  tool("C", "Bash", { command: "bun test --coverage" }, 2380),
  // B: plan session with a working doc; asked in prose
  { session: "B", kind: "ui.session_requested", payload: { prompt: "Plan this with me before any code: CSV export for invoices", kind: "plan", cwd: "/Users/me/code/billing", workspace: "personal" }, at: 50 },
  { session: "B", kind: "sidecar.session_started", payload: { sdk_session_id: "sdk-B", model: "claude-opus-5-5" }, at: 51 },
  say("B", "The plan is in the working doc. One open question: should exports run synchronously for small accounts, or always go through the job queue?", 2200),
  result("B", "plan ready", 2201, 0.18),
  // D: finished with a recap (diagram already drawn)
  ...start("D", "Refactor the settings schema", { cwd: "/Users/me/code/shop-worktrees/settings-schema", repo: "/Users/me/code/shop", branch: "mr/settings-schema" }, 60),
  todos("D", 5, [["Design schema", "Designing schema"], ["Migrate readers", "Migrating readers"], ["Write migration", "Writing migration"], ["Tests", "Running tests"]], 1500),
  tool("D", "Write", { file_path: "src/settings/schema.ts", content: "x\n".repeat(80) }, 1510),
  tool("D", "Edit", { file_path: "src/settings/read.ts", old_string: "a\n".repeat(12), new_string: "b\n".repeat(20) }, 1520),
  say("D", RECAP, 1900),
  result("D", "done", 1901, 1.12),
];

const planDoc: Doc = {
  id: "doc1", title: "CSV export for invoices", session_id: "B", version: 2, pending_notes: [], pending_changes: [],
  blocks: Object.fromEntries([
    { id: "b1", section: "goal", status: "proposed", takeaway: "Finance can export any date range of invoices as CSV in under a minute.", key: "Self-serve exports", body: "Today finance asks engineering for a SQL dump every month-end. The export should be self-serve from the invoices page." },
    { id: "b2", section: "scope", status: "proposed", takeaway: "Invoices and line items only; no payments or refunds in v1.", key: "Invoices + line items", body: "- Date range filter\n- Currency column\n- Excludes payments and refunds (v2)" },
    { id: "b3", section: "design", status: "proposed", takeaway: "A job-queue worker writes the file to S3 and emails a signed link.", key: "Queue → S3 → email", body: "The request enqueues a job; the worker streams rows to S3 (gzip CSV) and emails a 24h signed URL." },
    { id: "b4", section: "risk", status: "proposed", takeaway: "Large accounts (2M+ rows) could take minutes and hit the 15-minute worker timeout.", key: "Worker timeout", body: "Chunk by month and stream; alert above 10 minutes." },
    { id: "b5", section: "question", status: "open", takeaway: "Sync for small accounts, or always through the queue?", key: "Sync or queue?", body: "Sync is instant for 95% of accounts but adds a second code path.", data: { options: [{ label: "Always queue", description: "One path, simpler; a short wait for small accounts" }, { label: "Sync under 10k rows", description: "Instant for most; two code paths to test" }] } },
    { id: "b6", section: "verification", status: "proposed", takeaway: "Golden-file test on a fixture account plus a 2M-row load test.", key: "Golden file + load test", body: "" },
  ].map((b, i) => [b.id, { data: null, decision: null, updated: "", ...b, order: i }])),
} as Doc;

export const SCENARIOS: Record<string, Scenario> = {
  fresh: { events: [...ready], docs: [] },
  empty: { events: [...ready, onboarded], docs: [] },
  busy: { events: busy, docs: [planDoc] },
  archive: {
    events: [...busy, { session: "D", kind: "ui.session_archived", at: 2400 }, { session: "C", kind: "sidecar.session_ended", payload: { ok: true }, at: 2390 }, { session: "C", kind: "ui.session_archived", at: 2401 }],
    docs: [planDoc],
  },
};
