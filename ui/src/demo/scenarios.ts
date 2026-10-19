import type { Doc } from "../state/docs";
import REPORT_REPLY from "./fixtures/report-reply.md?raw";
import REVIEW_OVERVIEW from "./fixtures/review-overview.json";
import planDocFixture from "./fixtures/plan-doc.json";

// Demo scenarios (MR-40). Each is an event log the real reducer replays, plus the docs the core
// would have folded. `at` is seconds after a base 40 minutes ago.
type E = { session?: string; kind: string; payload?: Record<string, unknown>; at?: number };
export type Scenario = { events: E[]; docs: Doc[] };

const sidecarUp: E[] = [
  { kind: "sidecar.ready", payload: { claude: "/Users/me/.local/bin/claude" }, at: 0 },
  { kind: "sidecar.limits", payload: { available: true, plan: "max", five_hour: { utilization: 0.34, resetsAt: Math.round(Date.now() / 1000) + 7200 }, seven_day: { utilization: 0.58, resetsAt: null } }, at: 1 },
];
// Demos past the intro have made the permission choice (I106); ?demo=permissions hasn't.
const ready: E[] = [...sidecarUp, { kind: "ui.permission_mode_set", payload: { mode: "auto" }, at: 1 }];
const onboarded: E = { kind: "ui.onboarded", at: 2 };

// What each reply had in context, for the context meter: grows with the session, up to ~190k.
const usage = (at: number) => ({ input_tokens: 2, cache_read_input_tokens: 12_000 + (at % 400) * 450, cache_creation_input_tokens: 400, output_tokens: 60 });
const say = (session: string, text: string, at: number): E => ({ session, kind: "sidecar.sdk", payload: { message: { type: "assistant", message: { content: [{ type: "text", text }], usage: usage(at) } } }, at });
const tool = (session: string, name: string, input: Record<string, unknown>, at: number, id = `${name}-${at}`): E => ({ session, kind: "sidecar.sdk", payload: { message: { type: "assistant", message: { content: [{ type: "tool_use", id, name, input }], usage: usage(at) } } }, at });
const todos = (session: string, done: number, items: [string, string][], at: number): E => tool(session, "TodoWrite", { todos: items.map(([content, activeForm], i) => ({ content, activeForm, status: i < done ? "completed" : i === done ? "in_progress" : "pending" })) }, at);
const result = (session: string, text: string, at: number, cost = 0.3): E => ({ session, kind: "sidecar.sdk", payload: { message: { type: "result", is_error: false, result: text, total_cost_usd: cost, modelUsage: { "claude-opus-5-5": { costUSD: cost, contextWindow: 200_000 } } } }, at });
const start = (session: string, prompt: string, extra: Record<string, unknown>, at: number): E[] => [
  { session, kind: "ui.session_requested", payload: { prompt, kind: "blank", workspace: "personal", ...extra }, at },
  { session, kind: "sidecar.session_started", payload: { sdk_session_id: `sdk-${session}`, model: "claude-opus-5-5" }, at: at + 1 },
];

const RECAP = "Refactor is finished. Summary:\n1. Split settings into a typed schema with defaults.\n2. Migrated the three readers to the new accessor.\n3. Added a migration for existing user files.\n4. Risk: old desktop builds can't read the new format.\n5. All 211 tests pass.\nThe branch is mr/settings-schema.";

const busy: E[] = [
  ...ready, onboarded,
  // A: needs a permission (risky command)
  ...start("A", "Retire the old invoices table", { cwd: "/Users/me/code/shop-worktrees/retire-invoices", repo: "/Users/me/code/shop", branch: "mr/retire-invoices" }, 10),
  todos("A", 3, [["Find every reader of invoices_v1", "Finding every reader of invoices_v1"], ["Move readers to the new table", "Moving readers to the new table"], ["Backfill missing rows", "Backfilling missing rows"], ["Drop the old table", "Dropping the old table"], ["Remove the dead code", "Removing the dead code"]], 20),
  tool("A", "Edit", { file_path: "src/billing/invoices.ts", old_string: "export async function listInvoices(accountId: string) {\n  return db.invoices_v1.findMany({ where: { accountId } });\n}", new_string: "export async function listInvoices(accountId: string) {\n  return db.invoices.findMany({\n    where: { accountId, deletedAt: null },\n    orderBy: { issuedAt: \"desc\" },\n  });\n}" }, 60),
  // The description sounds routine; the command says production, with CASCADE.
  { session: "A", kind: "sidecar.permission_request", payload: { request_id: "pA", tool: "Bash", input: { command: "psql \"$PROD_DATABASE_URL\" -c 'DROP TABLE invoices_v1 CASCADE;'", description: "Drop the old invoices table" }, suggestions: null, decision_reason: null }, at: 2300 },
  // E: asks a structured question
  ...start("E", "Add rate limiting to the public API", { cwd: "/Users/me/code/shop-worktrees/rate-limit", repo: "/Users/me/code/shop", branch: "mr/rate-limit" }, 30),
  say("E", "I looked at the gateway and the middleware. Two ways to do this.\n\n| Option | Limits | Needs | Effort |\n|:--|:--|:--|--:|\n| API gateway | per IP | nothing new | about 30 min |\n| App middleware | per user | Redis, `RateLimit` config | about 3 h |", 200),
  { session: "E", kind: "sidecar.permission_request", payload: { request_id: "pE", tool: "AskUserQuestion", input: { questions: [{ question: "Where should the limiter live?", header: "Limiter", multiSelect: false, options: [{ label: "API gateway", description: "One place, no code change, coarse per-IP limits" }, { label: "App middleware", description: "Per-user limits, needs Redis" }] }, { question: "What should a limited client get back?", header: "Response", multiSelect: false, options: [{ label: "429 + Retry-After", description: "" }, { label: "Queue and slow down", description: "" }] }, { question: "Which routes need a limit?", header: "Routes", multiSelect: true, options: [{ label: "/login", description: "" }, { label: "/search", description: "" }, { label: "/upload", description: "" }] }] }, suggestions: null, decision_reason: null }, at: 2320 },
  // C: running, almost done
  ...start("C", "Bump dependencies and fix breakages", { cwd: "/Users/me/code/billing-worktrees/deps", repo: "/Users/me/code/billing", branch: "mr/deps" }, 40),
  todos("C", 4, [["Update lockfile", "Updating lockfile"], ["Fix type errors", "Fixing type errors"], ["Fix failing tests", "Fixing failing tests"], ["Update changelog", "Updating changelog"], ["Run the full suite", "Running the full suite"]], 2340),
  // A long build left running in the background (run_in_background), and one that already finished.
  tool("C", "Bash", { command: "bun install", description: "Install updated dependencies", run_in_background: true }, 2100, "bgC0"),
  { session: "C", kind: "sidecar.sdk", payload: { message: { type: "system", subtype: "task_started", tool_use_id: "bgC0", task_id: "b0", is_backgrounded: true, task_type: "local_bash" } }, at: 2100 },
  { session: "C", kind: "sidecar.sdk", payload: { message: { type: "system", subtype: "task_notification", tool_use_id: "bgC0", task_id: "b0", status: "completed", output_file: "/tmp/claude-501/deps/sdk-C/tasks/b0.output", summary: "Background command \"Install updated dependencies\" completed" } }, at: 2160 },
  tool("C", "Bash", { command: "bun run build:all > /tmp/build.log 2>&1", description: "Build every package", run_in_background: true }, 2200, "bgC1"),
  { session: "C", kind: "sidecar.sdk", payload: { message: { type: "system", subtype: "task_started", tool_use_id: "bgC1", task_id: "b1", is_backgrounded: true, task_type: "local_bash" } }, at: 2200 },
  { session: "C", kind: "sidecar.sdk", payload: { message: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "bgC1", content: "Command running in background with ID: b1. Output is being written to: /tmp/claude-501/deps/sdk-C/tasks/b1.output." }] } } }, at: 2200 },
  // Commands Claude suggests get a Run button; one you already ran sits in the side panel (MR-85).
  say("C", "Types compile again. While the suite runs, check the lockfile diff yourself:\n```bash\ngit diff --stat bun.lock\n```\nThen run `bun run lint` to catch the import order rule.", 2300),
  { session: "C", kind: "ui.run_started", payload: { run_id: "runC0", command: "bun outdated", cwd: "/Users/me/code/billing-worktrees/deps" }, at: 2310 },
  { session: "C", kind: "run.finished", payload: { run_id: "runC0", code: 0, status: "completed" }, at: 2318 },
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
  tool("D", "Write", { file_path: "src/settings/schema.ts", content: "import { z } from \"zod\";\n\n// One typed schema for every setting; unknown keys are dropped, missing ones get defaults.\nexport const Settings = z.object({\n  version: z.literal(2).default(2),\n  theme: z.enum([\"light\", \"dark\", \"system\"]).default(\"system\"),\n  fontSize: z.number().int().min(10).max(24).default(14),\n  telemetry: z.boolean().default(false),\n  editor: z.object({\n    tabSize: z.number().int().min(1).max(8).default(2),\n    wordWrap: z.boolean().default(true),\n  }).default({}),\n  sync: z.object({\n    enabled: z.boolean().default(false),\n    intervalMin: z.number().int().min(5).default(15),\n  }).default({}),\n});\n\nexport type Settings = z.infer<typeof Settings>;\n\nexport function parseSettings(raw: unknown): Settings {\n  return Settings.parse(raw ?? {});\n}\n" }, 1510),
  tool("D", "Edit", { file_path: "src/settings/read.ts", old_string: "export function readSettings(path: string) {\n  const raw = JSON.parse(fs.readFileSync(path, \"utf8\"));\n  return {\n    theme: raw.theme || \"system\",\n    fontSize: raw.fontSize || 14,\n    tabSize: raw.tabSize || 2,\n  };\n}", new_string: "import { parseSettings, type Settings } from \"./schema\";\n\nexport function readSettings(path: string): Settings {\n  if (!fs.existsSync(path)) return parseSettings({});\n  const raw = JSON.parse(fs.readFileSync(path, \"utf8\"));\n  // v1 files kept tabSize at the top level\n  if (raw.version !== 2) raw.editor = { tabSize: raw.tabSize, ...raw.editor };\n  return parseSettings(raw);\n}" }, 1520),
  say("D", RECAP, 1900),
  result("D", "done", 1901, 1.12),
];

const planDoc: Doc = {
  id: "doc1", title: "CSV export for invoices", session_id: "B", version: 2, pending_notes: [], pending_changes: [],
  blocks: Object.fromEntries([
    { id: "b1", section: "goal", status: "proposed", takeaway: "Finance can export any date range of invoices as CSV in under a minute.", key: "Self-serve exports", body: "Today finance asks engineering for a SQL dump every month-end. The export should be self-serve from the invoices page.", view: [{ type: "stats", items: [{ value: "<1", label: "min", detail: "to a file for 95% of accounts" }, { value: "0", label: "SQL dumps", detail: "asked of engineering per month" }, { value: "24", label: "h", detail: "signed link lifetime" }] }] },
    { id: "b2", section: "scope", status: "proposed", takeaway: "Invoices and line items only; no payments or refunds in v1.", key: "Invoices + line items", body: "- Date range filter\n- Currency column\n- Excludes payments and refunds (v2)", view: [{ type: "scope", in: ["Invoices", "Line items", "Date range filter", "Currency column"], out: ["Payments", "Refunds (v2)"] }] },
    { id: "b3", section: "design", status: "proposed", since: 2, was: "A sync endpoint streams the CSV straight to the browser.", takeaway: "A job-queue worker writes the file to S3 and emails a signed link.", key: "Queue → S3 → email", body: "The request enqueues a job; the worker streams rows to S3 (gzip CSV) and emails a 24h signed URL.", view: [{ type: "steps", items: [{ actor: "Finance", text: "Picks a date range and clicks Export" }, { actor: "API", text: "Enqueues a job", detail: "returns at once" }, { actor: "Worker", text: "Streams rows to S3 as gzip CSV" }, { actor: "Worker", text: "Emails a 24 h signed link" }] }, { type: "change_graph", nodes: [{ label: "Export button", mark: "~" }, { label: "Job queue", mark: "+" }, { label: "CSV worker", mark: "+" }, { label: "S3 bucket", mark: "~" }, { label: "Email link", mark: "+" }] }] },
    { id: "b4", section: "risk", status: "proposed", takeaway: "Large accounts (2M+ rows) could take minutes and hit the 15-minute worker timeout.", key: "Worker timeout", body: "Chunk by month and stream; alert above 10 minutes.", view: [{ type: "risks", items: [{ risk: "2M+ rows hit the 15-min worker timeout", mitigation: "Chunk by month and stream", level: "medium" }, { risk: "A stuck export goes unnoticed", mitigation: "Alert above 10 minutes", level: "low" }] }, { type: "tradeoff", label: "Chunk size vs time to the first file", x_unit: "rows per chunk", y_unit: "min", points: [{ x: 50000, y: 2 }, { x: 200000, y: 4 }, { x: 500000, y: 7 }, { x: 1000000, y: 12 }], pick: 200000 }] },
    { id: "b5", section: "question", status: "open", takeaway: "Sync for small accounts, or always through the queue?", key: "Sync or queue?", body: "Sync is instant for 95% of accounts but adds a second code path.", view: [{ type: "compare", criteria: ["Code paths", "Small accounts wait", "Test effort"], rows: [{ option: "Always queue", values: ["1", "~20 s", "Low"], recommended: true }, { option: "Sync under 10k rows", values: ["2", "none", "Double"] }] }], data: { options: [{ label: "Always queue", description: "One path, simpler; a short wait for small accounts" }, { label: "Sync under 10k rows", description: "Instant for most; two code paths to test" }] } },
    { id: "b7", section: "question", status: "open", takeaway: "Which formats ship in v1?", key: "Formats", body: "Finance asked for CSV; two teams also want XLSX.", data: { multiSelect: true, options: [{ label: "CSV", description: "what finance asked for" }, { label: "XLSX", description: "opens in Excel without import" }, { label: "JSON", description: "for the data team" }] } },
    { id: "b6", section: "verification", status: "proposed", takeaway: "Golden-file test on a fixture account plus a 2M-row load test.", key: "Golden file + load test", body: "", view: [{ type: "checklist", items: [{ label: "Golden file matches on the fixture account", ok: null, proof: "vitest export.golden" }, { label: "2M rows export in under 15 min", ok: null, proof: "load test on staging" }, { label: "Signed link expires after 24 h", ok: null }] }] },
  ].map((b, i) => [b.id, { data: null, decision: null, updated: "", since: 1, was: null, ...b, order: i }])),
} as Doc;

// The plan doc with every question answered by its first option.
const decided = (d: Doc): Doc["blocks"] => Object.fromEntries(Object.entries(d.blocks).map(([k, b]) => [k, b.section === "question" ? { ...b, decision: b.data?.options?.[0]?.label ?? "Yes", status: "decided" } : b]));

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

// Address (J8): /pr-address on your PR, every thread drawn up front (MR-126).
const addressEvents: E[] = [
  ...ready, onboarded,
  { session: "X", kind: "ui.session_requested", payload: { prompt: "/pr-address 479", kind: "address", cwd: "/Users/me/code/billing", workspace: "personal" }, at: 10 },
  { session: "X", kind: "sidecar.session_started", payload: { sdk_session_id: "sdk-X", model: "claude-opus-5-5" }, at: 11 },
  { session: "X", kind: "flow.address_threads", payload: { pr: "#479", round: "Round 2", moved_commits: 1, threads: [{ id: "t1", at: "export.ts:30", reviewer: "dana", short: "Stream rows instead of loading all", state: "open" }, { id: "t2", at: "export.ts:58", reviewer: "dana", short: "Name the job queue constant", state: "open" }, { id: "t3", at: "README.md:4", reviewer: "lee", short: "Typo", state: "resolved" }] }, at: 30 },
  { session: "X", kind: "flow.address_thread", payload: { id: "t1", reviewer: "dana", at: "export.ts:30", body: "This loads every invoice into memory. Big accounts will OOM the worker. Can we stream?", verdict: "Valid — 2M-row accounts exist (see load test).", evidence_file: "src/export.ts", evidence_code: "const rows = await db.invoices.findMany({ where })", options: [{ id: "a", label: "Stream with a cursor", detail: "Batches of 5k rows, constant memory", recommended: true }, { id: "b", label: "Paginate by month", detail: "Simpler; up to 31 queries" }, { id: "c", label: "Push back", detail: "Reply that v1 caps exports at 100k rows" }] }, at: 40 },
  { session: "X", kind: "flow.address_thread", payload: { id: "t2", reviewer: "dana", at: "export.ts:58", body: "Magic string 'exports' — make it a named constant.", verdict: "Valid, trivial.", evidence_file: "src/export.ts", evidence_code: "queue.add('exports', job)", options: [{ id: "a", label: "Add EXPORT_QUEUE constant", recommended: true }, { id: "b", label: "Push back" }] }, at: 41 },
  { session: "X", kind: "sidecar.sdk", payload: { message: { type: "result", is_error: false, result: "2 threads drawn", total_cost_usd: 0.2 } }, at: 42 },
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

// A report-shaped reply with a buried decision (MR-56).
const reportEvents: E[] = [
  ...ready, onboarded,
  ...start("P", "let’s revisit what is left before the shop launch", { cwd: "/Users/me/code/shop-worktrees/revisit", repo: "/Users/me/code/shop", branch: "mr/revisit" }, 10),
  tool("P", "Bash", { command: "git log --oneline -15 && ls docs && gh issue list --limit 30" }, 20),
  tool("P", "Read", { file_path: "docs/LAUNCH-CHECKLIST.md" }, 30),
  tool("P", "Read", { file_path: "docs/product-review-2026-10-01.md" }, 40),
  say("P", REPORT_REPLY, 300),
  result("P", "done", 301, 0.9),
];


// MR-142: screenshots for the image blocks, drawn inline so the demo needs no files.
const shot = (title: string, fill: string, off = 0) => `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="#f4f2ee"/><rect width="640" height="56" fill="#15181b"/><text x="24" y="36" font-family="sans-serif" font-size="20" fill="#fff">${title}</text><rect x="${180 + off}" y="150" width="280" height="44" fill="${fill}"/><text x="${250 + off}" y="178" font-family="sans-serif" font-size="16" fill="#fff">Sign in</text><rect x="180" y="100" width="280" height="32" fill="#ddd"/></svg>`)}`;

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
    { type: "images", ask: "both", items: [{ path: shot("Settings · light", "#2e7d6b"), caption: "Settings, light theme" }, { path: shot("Settings · narrow", "#2e7d6b", 60), caption: "Settings at 800 px" }, { path: shot("Settings · error", "#b3261e"), caption: "Invalid value state" }] },
    { type: "image_compare", before: { path: shot("Settings · main", "#2e7d6b"), label: "main" }, after: { path: shot("Settings · this branch", "#2e7d6b", 30), label: "this branch" } },
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

// A /review of a PR with earlier rounds (MR-58): the overview, waiting for "ok".
const reviewOverviewEvents: E[] = [
  ...ready, onboarded,
  { session: "R", kind: "ui.session_requested", payload: { prompt: "/review https://github.com/acme/shop/pull/482", kind: "review", cwd: "/Users/me/code/shop", workspace: "personal" }, at: 10 },
  { session: "R", kind: "sidecar.session_started", payload: { sdk_session_id: "sdk-R", model: "claude-opus-5-5" }, at: 11 },
  { session: "R", kind: "flow.review_overview", payload: REVIEW_OVERVIEW, at: 200 },
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

// MR-153: Claude Code's login ran out mid-session; the refused message waits to go again.
const signedOutEvents: E[] = [
  ...ready, onboarded,
  ...start("L", "Fix the flaky export test", { cwd: "/Users/me/code/shop" }, 10),
  say("L", "The export test races the clock; pinning the time.", 40),
  result("L", "Pinned the clock in the export test.", 60),
  { session: "L", kind: "ui.message_sent", payload: { text: "now run the whole suite" }, at: 2300 },
  { session: "L", kind: "sidecar.sdk", payload: { message: { type: "assistant", error: "authentication_failed", is_api_error_message: true, message: { content: [{ type: "text", text: "Not logged in · Please run /login" }] } } }, at: 2301 },
  { session: "L", kind: "sidecar.sdk", payload: { message: { type: "result", is_error: true, result: "Not logged in · Please run /login" } }, at: 2302 },
];


// The Overview (decision 40, MR-155): three workspaces with something to resume, in progress and to
// review in each, plus a clean finish that must not show. ?demo=workspaces
const inWs = (session: string, prompt: string, workspace: string, at: number): E[] => [...start(session, prompt, { cwd: `/Users/me/code/${workspace}`, workspace }, at)];
const workspacesEvents: E[] = [
  ...ready, onboarded,
  { kind: "ui.workspace_created", payload: { id: "ws_cockpit", name: "Cockpit dev", config_dir: "/demo/ws_cockpit" }, at: 3 },
  { kind: "ui.workspace_created", payload: { id: "ws_client", name: "Client X", config_dir: "/demo/ws_client" }, at: 4 },
  // Personal: one waiting on a layout pick, one fixing login, one ready to review, one finished cleanly.
  ...inWs("P1", "Fix login redirect loop", "personal", 10),
  todos("P1", 1, [["Reproduce the loop", "Reproducing the loop"], ["Fix the guard", "Fixing the guard"], ["Add a test", "Adding a test"]], 20),
  ...inWs("P2", "Pick a layout for the settings page", "personal", 30),
  say("P2", "Two layouts fit. Which one should I build: tabs or one long page?", 60), result("P2", "asked", 61),
  ...inWs("P3", "Docs sync script", "personal", 70),
  todos("P3", 2, [["Read the docs folder", "Reading"], ["Write the sync", "Writing"]], 80), tool("P3", "TodoWrite", { todos: [{ content: "Read the docs folder", status: "completed" }, { content: "Write the sync", status: "completed" }] }, 90), result("P3", "Sync script done.", 91),
  ...inWs("P4", "Bump the lockfile", "personal", 95), result("P4", "Bumped.", 96), { session: "P4", kind: "sidecar.session_ended", payload: { ok: true }, at: 97 },
  // Cockpit dev: a migration waiting on approval, two running, one interrupted.
  ...inWs("C1", "Approve the event-log migration", "ws_cockpit", 100),
  { session: "C1", kind: "sidecar.permission_request", payload: { request_id: "pC1", tool: "Bash", input: { command: "sqlite3 events.sqlite < migrate.sql" }, suggestions: null, decision_reason: null }, at: 140 },
  ...inWs("C2", "Voice: push to talk", "ws_cockpit", 110), todos("C2", 2, [["Capture", "Capturing"], ["Stream", "Streaming"], ["Transcribe", "Transcribing"], ["Insert", "Inserting"]], 150),
  ...inWs("C3", "Notify on needs-you", "ws_cockpit", 120), tool("C3", "Bash", { command: "cargo test notify::" }, 160),
  ...inWs("C4", "Release v0.1.6", "ws_cockpit", 130), todos("C4", 1, [["Bump version", "Bumping"], ["Tag", "Tagging"]], 135), { session: "C4", kind: "sidecar.session_ended", payload: { ok: false, reason: "Claude Code process exited with code 1" }, at: 170 },
  // Client X: an API spike that stopped with steps open, and a report in progress.
  ...inWs("X1", "API spike: bulk endpoints", "ws_client", 200), todos("X1", 1, [["Sketch", "Sketching"], ["Benchmark", "Benchmarking"], ["Write up", "Writing up"]], 210), result("X1", "Stopping here.", 220), { session: "X1", kind: "sidecar.session_ended", payload: { ok: true }, at: 221 },
  ...inWs("X2", "Quarterly usage report", "ws_client", 230), tool("X2", "Read", { file_path: "reports/q3.csv" }, 240),
].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));

// A crowded Overview (MR-157): six workspaces, one with a dozen sessions running, one empty, one with
// a very long name. ?demo=workspaces-busy
const crowdWs = [["ws_a", "Acme platform"], ["ws_b", "Billing"], ["ws_c", "Client work for the very long named enterprise account"], ["ws_d", "Docs"], ["ws_e", "Empty"]];
const workspacesBusyEvents: E[] = [
  ...ready, onboarded,
  ...crowdWs.map(([id, name], i) => ({ kind: "ui.workspace_created", payload: { id, name, config_dir: `/demo/${id}` }, at: 3 + i })),
  ...Array.from({ length: 12 }, (_, i) => [...inWs(`A${i}`, `Acme task ${i + 1}: migrate service ${i + 1}`, "ws_a", 20 + i * 4), tool(`A${i}`, "Bash", { command: `cargo test svc${i + 1}` }, 22 + i * 4)]).flat(),
  ...inWs("A_ask", "Approve the Acme deploy", "ws_a", 80),
  { session: "A_ask", kind: "sidecar.permission_request", payload: { request_id: "pA", tool: "Bash", input: { command: "kubectl apply -f prod.yaml" }, suggestions: null, decision_reason: null }, at: 81 },
  ...inWs("B1", "Refund flow", "ws_b", 90), tool("B1", "Read", { file_path: "billing/refund.ts" }, 91),
  ...inWs("C1", "Quarterly review deck for the enterprise account", "ws_c", 100), result("C1", "Draft ready.", 101),
  ...inWs("D1", "Fix broken links", "ws_d", 110), { session: "D1", kind: "sidecar.session_ended", payload: { ok: false, reason: "exit 1" }, at: 111 },
  ...inWs("P1", "Personal errand", "personal", 120), tool("P1", "Read", { file_path: "notes.md" }, 121),
].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));

export const SCENARIOS: Record<string, Scenario> = {
  workspaces: { events: workspacesEvents, docs: [
    { ...planDoc, id: "docW1", title: "Overview canvas", session_id: "C2", blocks: decided(planDoc) },
    { ...planDoc, id: "docW2", title: "Q4 plan", session_id: "X2", blocks: decided(planDoc), shipped_at: Date.now() - 3_600_000 },
  ] },
  "workspaces-busy": { events: workspacesBusyEvents, docs: [] },
  timeline: { events: timelineEvents, docs: [] },
  // The timeline sessions with nothing waiting on you: the grey, calm wall (film, MR-139).
  calm: { events: timelineEvents.filter((e) => e.kind !== "sidecar.permission_request"), docs: [] },
  "review-overview": { events: reviewOverviewEvents, docs: [] },
  plan: { events: planEvents, docs: [] },
  view: { events: viewEvents, docs: [] },
  report: { events: reportEvents, docs: [] },
  bugs: { events: bugEvents, docs: [] },
  review: { events: reviewEvents, docs: [] },
  address: { events: addressEvents, docs: [] },
  fresh: { events: [...sidecarUp], docs: [] },
  permissions: { events: [...sidecarUp, onboarded], docs: [] },
  neverask: { events: [...ready, { kind: "ui.permission_mode_set", payload: { mode: "never" }, at: 1 }, onboarded], docs: [] },
  empty: { events: [...ready, onboarded], docs: [] },
  // Recurring sessions (MR-167): one schedule with a finished, unread run in the review tray. ?demo=recurring
  recurring: { events: [...ready, onboarded,
    { kind: "ui.schedule_set", payload: { id: "sch1", name: "Daily PR digest", prompt: "Summarise the PRs waiting on me, oldest first", cwd: "~/code/billing", workspace: "personal", worktree: false, cadence: { kind: "weekdays", at: "09:00" }, permission_mode: "auto", paused: false }, at: 2 },
    { session: "RD", kind: "ui.session_requested", payload: { cwd: "~/code/billing", prompt: "Summarise the PRs waiting on me, oldest first", kind: "blank", workspace: "personal", schedule: "sch1" }, at: 10 },
    { session: "RD", kind: "schedule.fired", payload: { id: "sch1", session: "RD", reason: "due", slot: "2026-10-19T09:00" }, at: 10 },
    { session: "RD", kind: "sidecar.session_started", payload: { sdk_session_id: "sdk-RD", model: "claude-opus-5-5" }, at: 11 },
    { session: "RD", kind: "sidecar.sdk", payload: { message: { type: "assistant", message: { content: [{ type: "text", text: "3 PRs wait on you: #412 (4 days), #418, #421." }] } } }, at: 12 },
    { session: "RD", kind: "sidecar.sdk", payload: { message: { type: "result", is_error: false, result: "3 PRs wait on you: #412 (4 days), #418, #421.", total_cost_usd: 0.04 } }, at: 13 },
  ], docs: [] },
  busy: { events: busy, docs: [planDoc] },
  signedout: { events: signedOutEvents, docs: [] },
  // Doc lifecycle (MR-151): one stalled with open questions, one ready, one building, one shipped. ?demo=doclife
  doclife: { events: busy, docs: [
    { ...planDoc, updated_at: Date.now() - 5 * 86_400_000 },
    { ...planDoc, id: "doc2", title: "Settings schema v2", blocks: decided(planDoc), build_sessions: ["D"], updated_at: Date.now() - 3_600_000 },
    { ...planDoc, id: "doc4", title: "Nightly backup check", blocks: decided(planDoc), updated_at: Date.now() - 600_000 },
    { ...planDoc, id: "doc3", title: "Retire the old invoices table", blocks: decided(planDoc), build_sessions: ["A"], shipped_at: Date.now() - 600_000, updated_at: Date.now() - 600_000 },
  ] },
  // A 14-block working doc with long bodies, tables and lists (the doc map must stay usable).
  bigdoc: { events: [...ready, onboarded], docs: [planDocFixture as unknown as Doc] },
  // The same plan doc: a view on every block (MR-102/103): ?demo=multiplayer
  multiplayer: { events: [...ready, onboarded], docs: [planDocFixture as unknown as Doc] },
  broken: { events: [...busy, { session: "C", kind: "sidecar.session_ended", payload: { ok: false, reason: "Claude Code process exited with code 1\nError: ENOENT: no such file or directory, open '/Users/me/.claude/settings.json'\n    at Object.openSync (node:fs:596:3)\n    at readSettings (cli.js:12:9)" }, at: 2395 }], docs: [planDoc] },
  archive: {
    events: [...busy, { session: "D", kind: "ui.session_archived", at: 2400 }, { session: "C", kind: "sidecar.session_ended", payload: { ok: true }, at: 2390 }, { session: "C", kind: "ui.session_archived", at: 2401 }],
    docs: [planDoc],
  },
};
