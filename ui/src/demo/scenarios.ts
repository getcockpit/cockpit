import type { Doc } from "../state/docs";
import shop from "./shop.txt?raw";
import REVIEW482 from "./review482.json";
import planViewDoc from "./planview-doc.json";

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
  // A second workspace with something waiting (J17).
  { kind: "ui.workspace_created", payload: { id: "ws_client", name: "Client A", config_dir: "/demo/ws_client" }, at: 3 },
  { session: "F", kind: "ui.session_requested", payload: { prompt: "Migrate the client's billing to Stripe Tax", kind: "blank", cwd: "/Users/me/code/client-a", workspace: "ws_client" }, at: 70 },
  { session: "F", kind: "sidecar.session_started", payload: { sdk_session_id: "sdk-F", model: "claude-opus-5-5" }, at: 71 },
  { session: "F", kind: "sidecar.permission_request", payload: { request_id: "pF", tool: "Bash", input: { command: "stripe tax settings update --live", description: "Turn on Stripe Tax in live mode" }, suggestions: null, decision_reason: null }, at: 2330 },
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
    { id: "b3", section: "design", status: "proposed", since: 2, was: "A sync endpoint streams the CSV straight to the browser.", takeaway: "A job-queue worker writes the file to S3 and emails a signed link.", key: "Queue → S3 → email", body: "The request enqueues a job; the worker streams rows to S3 (gzip CSV) and emails a 24h signed URL." },
    { id: "b4", section: "risk", status: "proposed", takeaway: "Large accounts (2M+ rows) could take minutes and hit the 15-minute worker timeout.", key: "Worker timeout", body: "Chunk by month and stream; alert above 10 minutes." },
    { id: "b5", section: "question", status: "open", takeaway: "Sync for small accounts, or always through the queue?", key: "Sync or queue?", body: "Sync is instant for 95% of accounts but adds a second code path.", data: { options: [{ label: "Always queue", description: "One path, simpler; a short wait for small accounts" }, { label: "Sync under 10k rows", description: "Instant for most; two code paths to test" }] } },
    { id: "b6", section: "verification", status: "proposed", takeaway: "Golden-file test on a fixture account plus a 2M-row load test.", key: "Golden file + load test", body: "" },
  ].map((b, i) => [b.id, { data: null, decision: null, updated: "", since: 1, was: null, ...b, order: i }])),
} as Doc;

// Review (J8): /review on a PR, as an overview then snippets with findings.
export const REVIEW_SNIPPETS = [
  { n: 1, total: 3, area: "Payments", title: "Retry loop around the charge call", file: "src/payments/charge.ts", code: "@@ -40,6 +40,14 @@\n-  const res = await stripe.charge(req)\n+  for (let i = 0; i < 3; i++) {\n+    try { return await stripe.charge(req) }\n+    catch (e) { await sleep(2 ** i * 100) }\n+  }", explain: "Retries a failed charge up to three times with backoff.", good: "Backoff is bounded.", findings: [{ id: "f1", severity: "blocking", at: "charge.ts:42", text: "Retrying a charge without an idempotency key can double-charge the customer." }, { id: "f2", severity: "nit", at: "charge.ts:44", text: "Swallows the last error; rethrow after the final attempt." }] },
  { n: 2, total: 3, area: "Payments", title: "Webhook marks the order paid", file: "src/payments/webhook.ts", code: "@@ -12,3 +12,6 @@\n+  if (event.type === 'charge.succeeded') {\n+    await orders.markPaid(event.data.order_id)\n+  }", explain: "Marks the order paid when Stripe confirms.", good: "Simple and idempotent.", findings: [] },
  { n: 3, total: 3, area: "Tests", title: "Retry test", file: "src/payments/charge.test.ts", code: "@@ +1,8 @@\n+test('retries 3 times', async () => { /* … */ })", explain: "Covers the retry count.", good: "", findings: [{ id: "f3", severity: "should", at: "charge.test.ts:1", text: "Add a test that the idempotency key is reused across retries." }] },
];
const reviewEvents: E[] = [
  ...ready, onboarded,
  { session: "R", kind: "ui.session_requested", payload: { prompt: "/review https://github.com/acme/shop/pull/482", kind: "review", cwd: "/Users/me/code/shop", workspace: "personal" }, at: 10 },
  { session: "R", kind: "sidecar.session_started", payload: { sdk_session_id: "sdk-R", model: "claude-opus-5-5" }, at: 11 },
  { session: "R", kind: "flow.review_overview", payload: { pr: "#482", title: "Checkout: retry failed payments", tier: 2, tier_label: "Careful", summary: "Adds retries around the Stripe charge and a webhook that marks orders paid.", nodes: [{ label: "charge.ts", mark: "!", finding: "f1" }, { label: "webhook.ts" }, { label: "charge.test.ts", mark: "?" }], novelty: [{ label: "net-new", what: "Retry with backoff, the first retry logic in payments", where: "charge.ts" }, { label: "overlapping", what: "Idempotency key helper", where: "lib/stripe.ts:20" }], questions: ["Is the charge idempotent on Stripe's side?"], prior_threads: 0, total_snippets: 3 }, at: 30 },
  { session: "R", kind: "flow.review_snippet", payload: REVIEW_SNIPPETS[0], at: 40 },
  { session: "R", kind: "sidecar.sdk", payload: { message: { type: "result", is_error: false, result: "snippet 1", total_cost_usd: 0.2 } }, at: 41 },
];

// Address (J8): /pr-address on your PR, thread by thread.
const addressEvents: E[] = [
  ...ready, onboarded,
  { session: "X", kind: "ui.session_requested", payload: { prompt: "/pr-address 479", kind: "address", cwd: "/Users/me/code/billing", workspace: "personal" }, at: 10 },
  { session: "X", kind: "sidecar.session_started", payload: { sdk_session_id: "sdk-X", model: "claude-opus-5-5" }, at: 11 },
  { session: "X", kind: "flow.address_threads", payload: { pr: "#479", round: "Round 2", moved_commits: 1, threads: [{ id: "t1", at: "export.ts:30", reviewer: "dana", short: "Stream rows instead of loading all", state: "open" }, { id: "t2", at: "export.ts:58", reviewer: "dana", short: "Name the job queue constant", state: "open" }, { id: "t3", at: "README.md:4", reviewer: "lee", short: "Typo", state: "resolved" }] }, at: 30 },
  { session: "X", kind: "flow.address_thread", payload: { id: "t1", reviewer: "dana", at: "export.ts:30", body: "This loads every invoice into memory. Big accounts will OOM the worker. Can we stream?", verdict: "Valid — 2M-row accounts exist (see load test).", evidence_file: "src/export.ts", evidence_code: "const rows = await db.invoices.findMany({ where })", options: [{ id: "a", label: "Stream with a cursor", detail: "Batches of 5k rows, constant memory", recommended: true }, { id: "b", label: "Paginate by month", detail: "Simpler; up to 31 queries" }, { id: "c", label: "Push back", detail: "Reply that v1 caps exports at 100k rows" }] }, at: 40 },
  { session: "X", kind: "sidecar.sdk", payload: { message: { type: "result", is_error: false, result: "thread 1", total_cost_usd: 0.2 } }, at: 41 },
];

// Report an internal bug (J14): a finished god-mode fix session on the app's own repo.
const bugEvents: E[] = [
  ...ready, onboarded,
  { session: "G", kind: "ui.godmode_mark", payload: { note: "The changes box shows git's whole usage text", component: "ChangeMap" }, at: 5 },
  { session: "G", kind: "ui.session_requested", payload: { prompt: "God-mode mark on Cockpit (this app's own repo). The user marked the \"ChangeMap\" component as wrong in the focus view.\n\nTheir note: The changes box shows git's whole usage text\n\nWhat it showed: …", kind: "blank", cwd: "/Users/me/code/cockpit-worktrees/god-mode-mark-ab12", repo: "/Users/me/code/cockpit", branch: "mr/god-mode-mark-ab12", worktree: "/Users/me/code/cockpit-worktrees/god-mode-mark-ab12", workspace: "personal" }, at: 6 },
  { session: "G", kind: "sidecar.session_started", payload: { sdk_session_id: "sdk-G", model: "claude-opus-5-5" }, at: 7 },
  todos("G", 3, [["Find why", "Finding why"], ["Fix it", "Fixing it"], ["Add a regression test", "Adding a regression test"]], 60),
  tool("G", "Edit", { file_path: "ui/src/screens/ChangeMap.tsx", old_string: "a", new_string: "b\nc" }, 90),
  say("G", "Fixed: a folder that isn't a git repo now shows no change box instead of git's usage text. Added a regression test; ui tests pass. Committed as \"Fix: change box hides git's usage text\".", 200),
  result("G", "done", 201, 0.6),
];

// The user's real shop session (MR-56): a report-shaped reply with a buried decision.
const shopEvents: E[] = [
  ...ready, onboarded,
  ...start("P", "let’s revisit what do we have to be done in the project", { cwd: "/Users/me/go/github.com/shop/platform-worktrees/revisit", repo: "/Users/me/go/github.com/shop/platform", branch: "mr/revisit" }, 10),
  tool("P", "Bash", { command: "git log --oneline -15 && ls docs && gh issue list --limit 30" }, 20),
  tool("P", "Read", { file_path: "docs/GO-LIVE-CHECKLIST.md" }, 30),
  tool("P", "Read", { file_path: "docs/onboarding-polish-2026-10-07.md" }, 40),
  say("P", shop, 300),
  result("P", "done", 301, 0.9),
];


// MR-61: a session that answered with a view composed from the catalog (render_view).
const viewEvents: E[] = [
  ...ready, onboarded,
  ...start("V", "Where are we on the settings refactor?", { cwd: "/Users/me/code/shop-worktrees/settings", repo: "/Users/me/code/shop", branch: "mr/settings-schema" }, 10),
  { session: "V", kind: "view.rendered", payload: { title: "Settings refactor: where it stands", blocks: [
    { type: "progress", n: 4, total: 6, label: "Migrating readers", right: "about 30 min left" },
    { type: "tally", items: [{ n: 9, label: "readers migrated", tone: "done" }, { n: 2, label: "in progress", tone: "now" }, { n: 1, label: "deferred", tone: "deferred" }, { n: 3, label: "to go", tone: "todo" }] },
    { type: "takeaway", heading: "Done", status: "done", items: [{ title: "Typed schema", detail: "with defaults for every key" }, { title: "Migration", detail: "old files upgrade on first read" }] },
    { type: "takeaway", heading: "Needs you", status: "you", items: [{ title: "Old desktop builds", detail: "can't read the new format: ship a reader shim or bump the minimum version?", time: "about 15 min" }] },
    { type: "compare", criteria: ["Effort", "Risk", "Fit"], rows: [{ option: "Reader shim", values: ["2 h", "Low", "Keeps old builds working"], recommended: true }, { option: "Bump minimum version", values: ["10 min", "Medium", "Forces 4% of users to update"] }] },
    { type: "change_graph", nodes: [{ label: "settings.json", mark: "~" }, { label: "SettingsSchema", mark: "+" }, { label: "readers (12)", mark: "~" }, { label: "legacy parser", mark: "-" }] },
    { type: "checklist", items: [{ label: "Type-check", ok: true, proof: "tsc 0 errors" }, { label: "Unit tests", ok: true, proof: "211 passed" }, { label: "Migration on a real old file", ok: null }, { label: "Old desktop build reads it", ok: false, proof: "parse error" }] },
    { type: "snippet", file: "src/settings/read.ts · 40–44", code: " export function read(path) {\n-  return JSON.parse(fs.readFileSync(path))\n+  return SettingsSchema.parse(migrate(load(path)))\n }", note: "Every reader goes through the schema now." },
    { type: "tier", tier: 2, label: "Leverage · nothing on fire", detail: "old builds still read v1 files" },
    { type: "findings", items: [{ severity: "critical", title: "Old builds crash on the new format", where: "read.ts:42" }, { severity: "important", title: "Migration isn't atomic", where: "migrate.ts:18" }, { severity: "suggestion", title: "Name the schema version constant" }, { severity: "nitpick", title: "Stray console.log", where: "read.ts:9" }] },
    { type: "novelty", items: [{ verdict: "new", what: "SettingsSchema" }, { verdict: "adjacent", what: "migrate(), mirrors the db migrator" }, { verdict: "overlapping", what: "default merging", where: "config/defaults.ts:12" }, { verdict: "duplicate", what: "path resolver already on main" }] },
    { type: "tradeoff", label: "How long to keep the reader shim", points: [{ x: 1, y: 40 }, { x: 2, y: 81 }, { x: 3, y: 90 }, { x: 6, y: 96 }, { x: 12, y: 99 }], x_unit: "months", y_unit: "% of users covered", pick: 2 },
    { type: "fix_options", finding: "Old builds crash on the new format", options: [{ label: "Bump the minimum version", detail: "10 min, forces 4% to update" }, { label: "Ship a reader shim", detail: "2 h, nobody notices", recommended: true }] },
    { type: "thread", author: "marta", where: "round 2 · read.ts:42", state: "replied", body: "This throws on v1 files, so the desktop app will crash on launch.", note: "You replied \"will do\" in round 1, still open." },
    { type: "next", text: "Add the reader shim, then run the old-build check.", replies: ["Add the shim", "Bump the minimum version", "Explain the risk"] },
  ] }, at: 60 },
  result("V", "ok", 61),
];


// MR-62: a long-running session that published its plan; the panel stays pinned while you scroll.
const planStep = (at: number, doing: number): E => ({ session: "P", kind: "plan.updated", payload: { steps: ["Read the settings readers", "Design the typed schema", "Migrate the 12 readers", "Write the file migration", "Run the full suite", "Open the PR"].map((step, i) => ({ step, status: i < doing ? "done" : i === doing ? "doing" : "todo" })) }, at });
const planEvents: E[] = [
  ...ready, onboarded,
  ...start("P", "Refactor settings into a typed schema", { cwd: "/Users/me/code/shop-worktrees/settings", repo: "/Users/me/code/shop", branch: "mr/settings-schema" }, 10),
  planStep(20, 0),
  { session: "P", kind: "session.titled", payload: { title: "Typed settings schema migration" }, at: 21 },
  ...Array.from({ length: 14 }, (_, i) => tool("P", "Read", { file_path: `src/settings/reader${i}.ts` }, 30 + i)),
  planStep(60, 1),
  say("P", "The readers all parse JSON by hand. I'll introduce one schema with defaults and route every reader through it.", 70),
  planStep(100, 2),
  ...Array.from({ length: 12 }, (_, i) => tool("P", "Edit", { file_path: `src/settings/reader${i}.ts`, old_string: "a", new_string: "a\nb" }, 2300 + i * 5)),
  say("P", "9 of 12 readers migrated. The last three share a legacy parser; doing those together.", 2370),
  tool("P", "Bash", { command: "bun test src/settings", description: "Run the settings tests" }, 2385),
  
];

// The user's real /review of PR #482 (MR-58): the overview, waiting for "ok".
const review482Events: E[] = [
  ...ready, onboarded,
  { session: "R", kind: "ui.session_requested", payload: { prompt: "/review https://github.com/acme/platform/pull/482", kind: "review", cwd: "/Users/me/go/github.com/acme/platform", workspace: "personal" }, at: 10 },
  { session: "R", kind: "sidecar.session_started", payload: { sdk_session_id: "sdk-R", model: "claude-opus-5-5" }, at: 11 },
  { session: "R", kind: "flow.review_overview", payload: REVIEW482, at: 200 },
  say("R", "The overview is up: 2 new findings, everything else was raised in earlier rounds.\n\nNext: reply `ok` to start snippet 1 of 2.", 201),
  result("R", "overview", 202, 0.4),
];


// Timeline (MR-32): the Timeline.dc.html lanes. Now is at ~2400 s; each lane has a plan with real
// step timings and a rhythm of tool calls, so activity, waits and forecasts all have something to show.
const plan = (session: string, at: number, items: string[], done: number): E => ({ session, kind: "plan.updated", payload: { steps: items.map((step, i) => ({ step, status: i < done ? "done" : i === done ? "doing" : "todo" })) }, at });
const busyFor = (session: string, from: number, to: number, every: number): E[] => {
  const out: E[] = [];
  for (let t = from, i = 0; t < to; t += every + ((i * 37) % every), i++) out.push(tool(session, i % 3 ? "Edit" : "Bash", i % 3 ? { file_path: `src/${session}/f${i % 4}.ts`, old_string: "a", new_string: "a\nb" } : { command: "bun test" }, t));
  return out;
};
const timelineEvents: E[] = [
  ...ready, onboarded,
  // Waiting on you for 3 minutes after a busy half hour.
  ...start("TA", "Refactor auth middleware", { cwd: "/Users/me/code/shop-api-worktrees/auth", repo: "/Users/me/code/shop-api", branch: "mr/auth" }, 600),
  ...(["Map the middleware chain", "Extract the session check", "Move token refresh", "Migrate the routes", "Run the e2e suite"].map((_, i, a) => plan("TA", 610 + i * 300, a, i)).slice(0, 4)),
  ...busyFor("TA", 620, 2200, 40),
  { session: "TA", kind: "sidecar.permission_request", payload: { request_id: "pTA", tool: "AskUserQuestion", input: { questions: [{ question: "Run the migration on staging now?", header: "Migration", multiSelect: false, options: [{ label: "Yes", description: "" }, { label: "Later", description: "" }] }] }, suggestions: null, decision_reason: null }, at: 2220 },
  // A plan session close to handing you its spec.
  { session: "TB", kind: "ui.session_requested", payload: { prompt: "Plan this with me before any code: payments webhooks", kind: "plan", cwd: "/Users/me/code/shop-api", workspace: "personal" }, at: 1300 },
  { session: "TB", kind: "sidecar.session_started", payload: { sdk_session_id: "sdk-TB", model: "claude-opus-5-5" }, at: 1301 },
  ...(["Read the webhook handlers", "List the event types", "Draft the retry design", "Write the spec"].map((_, i, a) => plan("TB", 1310 + i * 240, a, i))),
  ...busyFor("TB", 1320, 2395, 50),
  // Two blank sessions finishing on their own.
  ...start("TC", "Add Redis to the infra", { cwd: "/Users/me/code/infra-worktrees/redis", repo: "/Users/me/code/infra", branch: "mr/redis" }, 1250),
  ...(["Add the module", "Wire the outputs", "Plan and apply"].map((_, i, a) => plan("TC", 1260 + i * 380, a, i))),
  ...busyFor("TC", 1270, 2398, 60),
  ...start("TD", "Fix the flaky API tests", { cwd: "/Users/me/code/shop-api-worktrees/tests", repo: "/Users/me/code/shop-api", branch: "mr/tests" }, 0),
  ...(["Find the flaky ones", "Seed the clock", "Isolate the DB", "Fix ordering", "Run 20 times"].map((_, i, a) => plan("TD", 10 + i * 500, a, i))),
  ...busyFor("TD", 20, 2390, 30),
  // Started four minutes ago: no history of its own, so it borrows the log's typical step.
  ...start("TE", "Rewrite the onboarding copy", { cwd: "/Users/me/code/shop-web-worktrees/copy", repo: "/Users/me/code/shop-web", branch: "mr/copy" }, 2160),
  plan("TE", 2170, ["Read the current flow", "Draft three variants", "Pick and apply", "Screenshot each step"], 0),
  ...busyFor("TE", 2180, 2396, 45),
  // No plan: one line at the bottom.
  ...start("TF", "Sweep the docs for stale links", { cwd: "/Users/me/code/shop-web-worktrees/docs", repo: "/Users/me/code/shop-web", branch: "mr/docs-sweep" }, 1900),
  ...busyFor("TF", 1910, 2390, 70),
  // Finished: ready to review.
  ...start("TG", "Bump dependencies", { cwd: "/Users/me/code/billing-worktrees/deps", repo: "/Users/me/code/billing", branch: "mr/deps" }, 300),
  plan("TG", 310, ["Update lockfile", "Fix breakages"], 2),
  tool("TG", "Edit", { file_path: "package.json", old_string: "a", new_string: "b" }, 900),
  tool("TG", "Edit", { file_path: "bun.lock", old_string: "a", new_string: "b" }, 910),
  result("TG", "All tests pass.", 1500),
  { session: "TG", kind: "sidecar.session_ended", payload: { ok: true }, at: 1510 },
].sort((a, b) => (a.at ?? 0) - (b.at ?? 0)); // the log is in time order, and the activity buckets rely on it

export const SCENARIOS: Record<string, Scenario> = {
  timeline: { events: timelineEvents, docs: [] },
  review482: { events: review482Events, docs: [] },
  plan: { events: planEvents, docs: [] },
  view: { events: viewEvents, docs: [] },
  shop: { events: shopEvents, docs: [] },
  bugs: { events: bugEvents, docs: [] },
  review: { events: reviewEvents, docs: [] },
  address: { events: addressEvents, docs: [] },
  fresh: { events: [...ready], docs: [] },
  empty: { events: [...ready, onboarded], docs: [] },
  busy: { events: busy, docs: [planDoc] },
  // A real 13-block working doc with long bodies, tables and lists (the doc map must stay usable).
  bigdoc: { events: [...ready, onboarded], docs: [planViewDoc as Doc] },
  broken: { events: [...busy, { session: "C", kind: "sidecar.session_ended", payload: { ok: false, reason: "Claude Code process exited with code 1\nError: ENOENT: no such file or directory, open '/Users/me/.claude/settings.json'\n    at Object.openSync (node:fs:596:3)\n    at readSettings (cli.js:12:9)" }, at: 2395 }], docs: [planDoc] },
  archive: {
    events: [...busy, { session: "D", kind: "ui.session_archived", at: 2400 }, { session: "C", kind: "sidecar.session_ended", payload: { ok: true }, at: 2390 }, { session: "C", kind: "ui.session_archived", at: 2401 }],
    docs: [planDoc],
  },
};
