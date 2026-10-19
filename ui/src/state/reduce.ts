import type { AppState, Attachment, CommandRow, Delivery, Diagram, FileChange, McpServer, McpState, MrEvent, PendingAsk, ProseKind, Run, SessionKind, SessionState, Span, Todo, TranscriptItem, ViewBlock } from "./types";

// Packaged builds (scripts/package.sh sets VITE_MR_PACKAGED=1) go to people without the /review
// command, so auto-review starts off there (MR-93). Settings → Auto-review still turns it on.
export const autoReviewDefault = (env: { VITE_MR_PACKAGED?: string }) => env.VITE_MR_PACKAGED !== "1";

export const initialState: AppState = {
  sessions: {},
  order: [],
  usage: { fiveHour: null, weekly: null, resetsAt: null, weeklyResetsAt: null },
  models: [],
  sidecar: { up: false, claude: null },
  lastEventId: null,
  instance: null,
  dismissed: [],
  workspaces: [{ id: "personal", name: "Personal", configDir: null, folder: null }],
  theme: "control-room",
  look: { scale: 1, density: "default" },
  autoReview: autoReviewDefault(import.meta.env),
  notifications: true,
  compactWindow: 200_000,
  sessionCap: 10,
  permissionMode: null,
  presets: [],
  clef: { day: "", calls: 0, tokens: 0, errors: 0 },
  cockpitLayer: false,
  cockpit: { month: "", calls: 0, tokens: 0, usd: 0, errors: 0 },
  account: { checked: false, signedIn: false, plan: null },
  onboarded: false,
  onboardingResetAt: null,
  recovered: null,
  lastBuildAt: null,
  selfbuild: null,
  update: { phase: "idle", step: null, log: null, subjects: [], startedAt: null, whatsNew: null, restarting: null },
  overviewLayout: {},
};

function newSession(id: string, at: number, title = "", cwd = "", kind: SessionKind = "blank"): SessionState {
  return {
    id, kind, preset: null, workspace: "personal", title, name: null, autoTitle: null, cwd, repo: null, branch: null, sdkSessionId: null, model: null, modelChoice: null, effort: null, modelError: null, status: "starting", startedAt: at, lastActivity: at, heardAt: at, turnOpen: false,
    pending: [], transcript: [], todos: [], runs: [], files: {}, activity: new Array(30).fill(0), spans: [{ status: "starting", from: at, to: null }], costUsd: 0, context: { used: null, window: null }, error: null, review: null, address: null, kinds: {}, diagrams: {}, archivedAt: null, partial: false, fixApplied: null, fromDeleted: null, commands: [], mcp: null, backgroundTasks: [], goal: null, owner: null, signedOut: null,
  };
}

const lines = (s: unknown) => (typeof s === "string" && s.length ? s.split("\n").length : 0);

// Replays one event onto the state. Pure: the same log always yields the same state.
export function reduce(state: AppState, ev: MrEvent): AppState {
  const p = ev.payload;
  // Another copy's rows can arrive a little out of order (MR-99): the newest id wins.
  const next: AppState = { ...state, lastEventId: state.lastEventId && state.lastEventId > ev.id ? state.lastEventId : ev.id };
  const sid = ev.session_id;

  if (ev.kind === "sidecar.ready") {
    // A fresh sidecar means any session still running before it died with the old one; another
    // copy's sidecar starting doesn't touch this copy's sessions (MR-99).
    const sessions = interrupt(next.sessions, ev.created_at, (s) => ownedBy(s, ev.origin));
    return { ...next, sessions, sidecar: ev.origin && next.instance && ev.origin !== next.instance ? next.sidecar : { up: true, claude: (p.claude as string) ?? null } };
  }
  // Claude Code was installed (or removed) since the sidecar started: it found out on a re-check.
  if (ev.kind === "sidecar.claude") return ev.origin && next.instance && ev.origin !== next.instance ? next : { ...next, sidecar: { ...next.sidecar, claude: (p.claude as string) ?? null } };
  // Another copy quit or died: its sessions stop there and can be resumed here (MR-99).
  if (ev.kind === "app.stopped") {
    const gone = (s: SessionState) => s.owner !== null && s.owner === p.origin;
    return { ...next, sessions: loseRuns(interrupt(next.sessions, ev.created_at, gone), ev.created_at, gone) };
  }
  // A build done in the background offers to relaunch into it, wherever you are, until you do or say later.
  if (ev.kind === "selfbuild.started") return { ...next, selfbuild: { id: String(p.build_id), branch: String(p.branch ?? ""), sha: String(p.sha ?? ""), phase: "building" } };
  if (ev.kind === "selfbuild.finished") {
    const b = next.selfbuild && next.selfbuild.id === String(p.build_id) ? next.selfbuild : null;
    return { ...next, lastBuildAt: p.ok ? ev.created_at : next.lastBuildAt, selfbuild: p.ok && b ? { ...b, phase: "ready" } : null };
  }
  if (ev.kind === "ui.build_dismissed") return { ...next, selfbuild: null };
  if (ev.kind.startsWith("update.") || ev.kind === "app.started" || ev.kind === "ui.update_seen" || ev.kind === "ui.update_dismissed") {
    const u = next.update;
    const strs = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
    switch (ev.kind) {
      case "update.started": return { ...next, update: { ...u, phase: "building", step: null, log: null, subjects: strs(p.subjects), startedAt: ev.created_at } };
      case "update.step": return { ...next, update: { ...u, step: String(p.step ?? "") } };
      case "update.finished": return { ...next, update: { ...u, phase: p.ok ? "ready" : "failed", step: p.ok ? null : String(p.step ?? ""), log: p.ok ? null : String(p.log ?? "") } };
      case "update.restarting": return { ...next, update: { ...u, restarting: strs(p.subjects) } };
      // A fresh start: whatever was building belonged to the old app; an update we restarted for is now live.
      // Runs still marked running were children of the old app: how they ended wasn't seen (MR-85).
      case "app.started": return { ...next, sessions: loseRuns(next.sessions, ev.created_at, (s) => ownedBy(s, ev.origin)), lastBuildAt: ev.created_at, selfbuild: null, update: { ...initialState.update, whatsNew: u.restarting ?? null } };
      case "ui.update_seen": return { ...next, update: { ...u, whatsNew: null } };
      case "ui.update_dismissed": return { ...next, update: { ...u, phase: "idle", step: null, log: null } };
    }
    return next;
  }
  if (ev.kind === "app.recovered") return { ...next, recovered: { crashedSlot: String(p.crashed_slot ?? ""), log: String(p.log ?? ""), at: ev.created_at } };
  if (ev.kind === "ui.recovery_dismissed") return { ...next, recovered: null };
  if (ev.kind === "ui.onboarded") return { ...next, onboarded: true };
  if (ev.kind === "ui.onboarding_reset") return { ...next, onboarded: false, onboardingResetAt: ev.id };
  if (ev.kind === "sidecar.limits") {
    // Limits double as the sign-in check: they're only available to a signed-in subscription.
    const account = { checked: true, signedIn: !!p.available, plan: (p.plan as string) ?? null };
    if (!p.available) return { ...next, account };
    const f = p.five_hour as { utilization: number; resetsAt: number | null } | null, w = p.seven_day as { utilization: number; resetsAt: number | null } | null;
    return { ...next, account, usage: { fiveHour: f?.utilization ?? next.usage.fiveHour, weekly: w?.utilization ?? next.usage.weekly, resetsAt: f?.resetsAt ?? next.usage.resetsAt, weeklyResetsAt: w?.resetsAt ?? next.usage.weeklyResetsAt } };
  }
  // An empty list is a failed lookup: keep the rows we had.
  if (ev.kind === "sidecar.models") return Array.isArray(p.models) && p.models.length ? { ...next, models: p.models as AppState["models"] } : next;
  if (ev.kind === "sidecar.terminated") return { ...next, sidecar: { up: false, claude: state.sidecar.claude } };

  if (ev.kind === "ui.workspace_created") return { ...next, workspaces: [...next.workspaces, { id: String(p.id), name: String(p.name), configDir: (p.config_dir as string) ?? null, folder: null }] };
  if (ev.kind === "ui.workspace_deleted") {
    // Its sessions become read-only history in Personal's archive; their Claude history went with the workspace.
    const id = String(p.id), name = String(p.name ?? "workspace");
    const sessions = Object.fromEntries(Object.entries(next.sessions).map(([k, s]) => [k, s.workspace === id ? { ...s, workspace: "personal", archivedAt: s.archivedAt ?? ev.created_at, fromDeleted: name, pending: [], status: s.status === "ended" || s.status === "error" ? s.status : "ended" as const } : s]));
    const { [id]: _, ...overviewLayout } = next.overviewLayout;
    return { ...next, sessions, workspaces: next.workspaces.filter((w) => w.id !== id), overviewLayout };
  }
  if (ev.kind === "ui.workspace_folder_set") return { ...next, workspaces: next.workspaces.map((w) => (w.id === p.id ? { ...w, folder: (p.folder as string) ?? null } : w)) };
  if (ev.kind === "ui.workspace_renamed") return { ...next, workspaces: next.workspaces.map((w) => (w.id === p.id ? { ...w, name: String(p.name) } : w)) };
  if (ev.kind === "ui.workspaces_reordered") {
    // Ids in the given order first; any it doesn't name (created since) keep their place after them.
    const order = Array.isArray(p.order) ? (p.order as unknown[]).map(String) : [];
    const rank = (id: string) => { const i = order.indexOf(id); return i < 0 ? order.length : i; };
    return { ...next, workspaces: [...next.workspaces].sort((a, b) => rank(a.id) - rank(b.id)) };
  }
  // A workspace dragged on the Overview canvas (decision 40): its rectangle's top-left, in canvas units.
  if (ev.kind === "ui.overview_tidied") return { ...next, overviewLayout: {} };
  if (ev.kind === "ui.overview_moved") return Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)) ? { ...next, overviewLayout: { ...next.overviewLayout, [String(p.workspace)]: { x: Number(p.x), y: Number(p.y) } } } : next;
  if (ev.kind === "ui.look_set") return { ...next, look: { scale: Number(p.scale ?? next.look.scale) || 1, density: (["compact", "default", "roomy"].includes(String(p.density)) ? p.density : next.look.density) as AppState["look"]["density"] } };
  if (ev.kind === "ui.cockpit_layer_set") return { ...next, cockpitLayer: p.on === true };
  if (ev.kind === "cockpit.usage") {
    // One model call Cockpit made on its own key: metered, never session activity.
    const month = new Date(ev.created_at).toISOString().slice(0, 7);
    const m = next.cockpit.month === month ? next.cockpit : { month, calls: 0, tokens: 0, usd: 0, errors: 0 };
    const tokens = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"].reduce((n, k) => n + Number(p[k] ?? 0), 0);
    return { ...next, cockpit: p.ok ? { ...m, calls: m.calls + 1, tokens: m.tokens + tokens, usd: m.usd + Number(p.cost_usd ?? 0) } : { ...m, errors: m.errors + 1 } };
  }
  if (ev.kind === "ui.compact_window_set") return { ...next, compactWindow: typeof p.tokens === "number" ? p.tokens : null };
  if (ev.kind === "ui.session_cap_set") return { ...next, sessionCap: typeof p.cap === "number" ? Math.max(1, p.cap) : next.sessionCap };
  if (ev.kind === "ui.permission_mode_set") return { ...next, permissionMode: p.mode === "auto" || p.mode === "acceptEdits" || p.mode === "default" || p.mode === "never" ? p.mode : next.permissionMode };
  if (ev.kind === "ui.auto_review_set") return { ...next, autoReview: p.on !== false };
  if (ev.kind === "ui.notifications_set") return { ...next, notifications: p.on !== false };
  if (ev.kind === "ui.theme_set") return { ...next, theme: String(p.theme) };
  if (ev.kind === "ui.preset_saved") {
    const pr = { id: String(p.id), name: String(p.name ?? ""), template: String(p.template ?? ""), worktree: p.worktree !== false };
    const at = next.presets.findIndex((x) => x.id === pr.id);
    return { ...next, presets: at < 0 ? [...next.presets, pr] : next.presets.map((x, i) => (i === at ? pr : x)) };
  }
  if (ev.kind === "ui.preset_removed") return { ...next, presets: next.presets.filter((x) => x.id !== p.id) };
  if (ev.kind === "ui.suggestion_dismissed") return { ...next, dismissed: [...next.dismissed, String(p.id)] };
  if (ev.kind === "ui.session_requested" && sid) {
    const kind = (["review", "address", "plan", "blank"].includes(String(p.kind)) ? p.kind : "blank") as SessionKind;
    const existing = next.sessions[sid];
    const where = { repo: (p.repo as string) ?? null, branch: (p.branch as string) ?? null, workspace: (p.workspace as string) ?? "personal", preset: (p.preset as string) ?? null };
    if (existing) {
      // A resume (or a request logged after early sidecar events): keep history, restart the status.
      const resumed = p.resume ? { status: "starting" as const, error: null, archivedAt: null } : {};
      return { ...next, sessions: { ...next.sessions, [sid]: { ...existing, kind, ...resumed, owner: ev.origin ?? null, spans: p.resume ? track(existing, "starting", ev.created_at) : existing.spans, title: existing.title || String(p.prompt ?? ""), cwd: existing.cwd || String(p.cwd ?? ""), repo: existing.repo ?? where.repo, branch: existing.branch ?? where.branch, preset: existing.preset ?? where.preset } } };
    }
    const fresh = newSession(sid, ev.created_at, String(p.prompt ?? ""), String(p.cwd ?? ""), kind);
    // Files sent with the first prompt: it shows as your first message, so they can be seen.
    const files = attached(p);
    if (files.attachments) fresh.transcript = [{ kind: "user", id: ev.id, text: String(p.prompt ?? ""), at: ev.created_at, ...files }];
    return { ...next, sessions: { ...next.sessions, [sid]: { ...fresh, ...where, owner: ev.origin ?? null } }, order: [...next.order, sid] };
  }
  if (ev.kind === "picker.layer2" && sid) {
    // A render decision, not session activity: annotate the item and tick the meter, nothing else.
    const day = new Date(ev.created_at).toISOString().slice(0, 10);
    const m = next.clef.day === day ? next.clef : { day, calls: 0, tokens: 0, errors: 0 };
    const clef = p.layer === "model" ? { ...m, calls: m.calls + 1, tokens: m.tokens + Number(p.tokens ?? 0) } : p.error ? { ...m, errors: m.errors + 1 } : m;
    const s = next.sessions[sid];
    if (!s) return { ...next, clef };
    const kind: ProseKind = { label: p.label as ProseKind["label"], p: Number(p.p ?? 0), layer: p.layer === "model" ? "model" : "code" };
    return { ...next, clef, sessions: { ...next.sessions, [sid]: { ...s, kinds: { ...s.kinds, [String(p.item_id)]: kind } } } };
  }
  if ((ev.kind === "ui.session_archived" || ev.kind === "ui.session_unarchived") && sid && next.sessions[sid]) {
    return { ...next, sessions: { ...next.sessions, [sid]: { ...next.sessions[sid], archivedAt: ev.kind === "ui.session_archived" ? ev.created_at : null } } };
  }
  // Model and effort (MR-73): your pick shows at once; Claude Code's answer confirms or refuses it.
  // Settings, not activity: they don't touch the session's status or sparkline.
  if (ev.kind === "ui.model_set" && sid && next.sessions[sid]) {
    const s = next.sessions[sid];
    const str = (v: unknown) => (typeof v === "string" ? v : null);
    return { ...next, sessions: { ...next.sessions, [sid]: { ...s, modelError: null, ...("model" in p ? { modelChoice: str(p.model) } : {}), ...("effort" in p ? { effort: str(p.effort) } : {}) } } };
  }
  if (ev.kind === "sidecar.model_set" && sid && next.sessions[sid]) {
    const s = next.sessions[sid];
    const switched = p.ok && typeof p.model === "string" ? { model: p.model } : {};
    return { ...next, sessions: { ...next.sessions, [sid]: { ...s, ...switched, modelError: p.ok ? null : String(p.error ?? "Claude Code refused the switch") } } };
  }
  // Slash commands and MCP servers (MR-87): what the session offers, not activity.
  if ((ev.kind === "sidecar.commands" || ev.kind === "sidecar.mcp_status" || ev.kind === "ui.mcp_action") && sid && next.sessions[sid]) {
    const s = next.sessions[sid];
    const upd = (x: Partial<SessionState>) => ({ ...next, sessions: { ...next.sessions, [sid]: { ...s, ...x } } });
    if (ev.kind === "sidecar.commands") return Array.isArray(p.commands) && p.commands.length ? upd({ commands: p.commands as CommandRow[] }) : next;
    const mcp: McpState = s.mcp ?? { servers: [], at: ev.created_at, busy: null, done: null, error: null };
    if (ev.kind === "ui.mcp_action") return upd({ mcp: { ...mcp, busy: String(p.server ?? ""), done: null } });
    const fresh = Array.isArray(p.servers) && p.servers.length ? (p.servers as McpServer[]) : mcp.servers;
    return upd({ mcp: { servers: fresh, at: ev.created_at, busy: null, done: (p.done as McpState["done"]) ?? null, error: typeof p.error === "string" ? p.error : null } });
  }
  if (ev.kind === "picker.layer3" && sid) {
    const s = next.sessions[sid];
    if (!s) return next;
    return { ...next, sessions: { ...next.sessions, [sid]: { ...s, diagrams: { ...s.diagrams, [String(p.item_id)]: (p.diagram as Diagram | null) ?? null } } } };
  }
  if (!sid) return next;

  const base = next.sessions[sid] ?? newSession(sid, ev.created_at);
  const order = next.sessions[sid] ? next.order : [...next.order, sid];
  const s: SessionState = { ...base, lastActivity: ev.created_at, activity: bump(base, ev.created_at) };

  switch (ev.kind) {
    case "sidecar.session_started":
      s.sdkSessionId = (p.sdk_session_id as string) ?? null;
      s.model = (p.model as string) ?? null;
      s.status = "working";
      break;
    case "sidecar.permission_request": {
      if (p.auto_allowed) break; // Never ask let it through in the core (I109): no card
      const tool = String(p.tool);
      const ask: PendingAsk = tool === "AskUserQuestion"
        ? { kind: "question", requestId: String(p.request_id), questions: ((p.input as { questions?: unknown }).questions ?? []) as never, input: p.input as Record<string, unknown>, at: ev.created_at }
        : { kind: "permission", requestId: String(p.request_id), tool, input: (p.input ?? {}) as Record<string, unknown>, suggestions: (p.suggestions as unknown[]) ?? null, reason: (p.decision_reason as string) ?? null, at: ev.created_at };
      s.pending = [...s.pending, ask];
      s.status = "needs_you";
      break;
    }
    case "ui.permission_answered":
      s.pending = s.pending.filter((a) => a.requestId !== p.request_id);
      s.status = s.pending.length ? "needs_you" : "working";
      break;
    case "ui.fix_applied":
      s.fixApplied = ev.created_at;
      break;
    case "ui.message_sent":
      s.transcript = [...s.transcript, { kind: "user", id: ev.id, text: String(p.text ?? ""), at: ev.created_at, delivery: s.turnOpen ? "queued" : "sending", ...attached(p) }];
      if (s.review?.publish && /^publish( and approve)?$/.test(String(p.text).trim())) s.review = { ...s.review, published: true, approved: String(p.text).trim() === "publish and approve" };
      s.status = "working";
      break;
    case "ui.run_started":
      s.runs = [...s.runs, { id: String(p.run_id ?? ev.id), command: String(p.command ?? ""), cwd: String(p.cwd ?? ""), status: "running", code: null, from: ev.created_at, to: null }];
      break;
    case "run.finished": {
      const status = (["completed", "failed", "stopped"].includes(String(p.status)) ? p.status : "completed") as Run["status"];
      s.runs = s.runs.map((r) => (r.id === p.run_id ? { ...r, status, code: typeof p.code === "number" ? p.code : null, to: ev.created_at } : r));
      break;
    }
    case "session.titled":
      s.autoTitle = String(p.title ?? "").trim() || s.autoTitle;
      break;
    case "ui.session_moved":
      s.workspace = String(p.to ?? s.workspace); // its conversation went with it (MR-154)
      break;
    case "ui.session_renamed":
      s.name = String(p.name ?? "").trim() || null; // an empty name hands the title back to Claude
      break;
    case "plan.updated": {
      // Claude's plan (plan_set, MR-62). A step keeps its start time while it stays in progress.
      const prev = new Map(s.todos.map((x) => [x.content, x]));
      const STATUS = { done: "completed", doing: "in_progress", todo: "pending" } as const;
      s.todos = (Array.isArray(p.steps) ? (p.steps as { step?: unknown; status?: unknown }[]) : []).map((x) => {
        const content = String(x.step ?? ""), status = STATUS[String(x.status) as keyof typeof STATUS] ?? "pending";
        const was = prev.get(content);
        const since = status === "in_progress" ? (was?.status === "in_progress" && was.since ? was.since : ev.created_at) : was?.since;
        // A step's end time sticks; one that arrives already done starts and ends here (Timeline, MR-32).
        return status === "completed" ? { content, status, since: since ?? ev.created_at, doneAt: was?.doneAt ?? ev.created_at } : { content, status, since };
      });
      break;
    }
    case "view.rendered":
      s.transcript = [...s.transcript, { kind: "view", id: ev.id, title: String(p.title ?? ""), blocks: Array.isArray(p.blocks) ? (p.blocks as ViewBlock[]) : [], at: ev.created_at }];
      break;
    case "sidecar.sdk":
      s.heardAt = ev.created_at;
      applySdk(s, p.message as Record<string, unknown>, ev, next);
      break;
    case "flow.review_overview":
    case "flow.review_snippet":
    case "flow.review_publish_ready":
    case "flow.review_unchanged":
    case "flow.review_published":
    case "ui.review_noted":
    case "ui.review_unnoted":
      s.review = reviewStep(s.review, ev.kind, p);
      break;
    case "flow.address_threads":
    case "flow.address_thread":
    case "flow.address_proof":
    case "flow.address_reply":
    case "flow.address_fixing":
    case "flow.address_done":
    case "ui.address_chosen":
      s.address = addressStep(s.address, ev.kind, p);
      break;
    case "sidecar.session_ended":
      s.status = p.ok ? "ended" : "error";
      s.error = p.ok ? null : String(p.reason ?? "session failed");
      s.pending = [];
      s.turnOpen = false;
      // The goal lives in the run: a resumed session reports it again if Claude Code restores it.
      s.goal = null;
      s.transcript = settle(s.transcript, ["sending", "queued", "taken"], "lost");
      break;
  }
  if (s.status !== base.status) s.spans = track(base, s.status, ev.created_at, s.status === "needs_you" ? askLabel(s.pending[0]) : undefined);
  // Whatever this event added belongs to the plan step in progress (MR-69: the transcript groups by step).
  const doing = s.todos.find((x) => x.status === "in_progress")?.content;
  if (doing && s.transcript.length > base.transcript.length) {
    s.transcript = s.transcript.map((x, i) => (i >= base.transcript.length && !x.step ? { ...x, step: doing } : x));
  }
  return { ...next, sessions: { ...next.sessions, [sid]: s }, order };
}

// Whether a start or sidecar restart by copy `origin` affects this session. Rows and sessions from
// before MR-99 carry no origin: those keep the old rule (everything).
function ownedBy(s: SessionState, origin: string | null | undefined): boolean {
  return !origin || s.owner === null || s.owner === origin;
}

function interrupt(sessions: AppState["sessions"], at: number, which: (s: SessionState) => boolean): AppState["sessions"] {
  const out = { ...sessions };
  for (const [id, s] of Object.entries(sessions)) {
    if (which(s) && !["ended", "error", "interrupted"].includes(s.status)) out[id] = { ...s, status: "interrupted", spans: track(s, "interrupted", at), pending: [], turnOpen: false, goal: null, transcript: settle(s.transcript, ["sending", "queued", "taken"], "lost") };
  }
  return out;
}

/** Open in another running copy of the app (dev vs /Applications): shown here, driven there (MR-99). */
export function elsewhere(state: AppState, s: SessionState): boolean {
  return s.owner !== null && state.instance !== null && s.owner !== state.instance && !["ended", "error", "interrupted"].includes(s.status);
}

function loseRuns(sessions: AppState["sessions"], at: number, which: (s: SessionState) => boolean): AppState["sessions"] {
  const out = { ...sessions };
  for (const [id, s] of Object.entries(sessions)) {
    if (which(s) && s.runs.some((r) => r.status === "running")) out[id] = { ...s, runs: s.runs.map((r) => (r.status === "running" ? { ...r, status: "lost" as const, to: at } : r)) };
  }
  return out;
}

// Closes the open span and opens one for the new status. Keeps the last 60: the Timeline shows 30 minutes.
function track(s: SessionState, status: SessionState["status"], at: number, label?: string): Span[] {
  const last = s.spans[s.spans.length - 1];
  if (last && last.status === status && last.to === null) return s.spans;
  const closed = last && last.to === null ? [...s.spans.slice(0, -1), { ...last, to: at }] : s.spans;
  return [...closed, { status, from: at, to: null, ...(label ? { label } : {}) }].slice(-60);
}

// What a session waits on, in a few words: the question's header or the tool asking permission.
function askLabel(a: PendingAsk | undefined): string | undefined {
  if (!a) return undefined;
  return a.kind === "question" ? a.questions[0]?.header || a.questions[0]?.question : a.tool;
}

function bump(s: SessionState, at: number): number[] {
  // 30 one-minute buckets ending at the minute of the session's latest activity. Buckets follow the
  // clock's minutes, so a steady stream of events 40 s apart still moves along (MR-32).
  const shift = Math.max(0, Math.floor(at / 60000) - Math.floor(s.lastActivity / 60000));
  const a = shift >= 30 ? new Array(30).fill(0) : [...s.activity.slice(shift), ...new Array(shift).fill(0)];
  a[29] += 1;
  return a;
}

function applySdk(s: SessionState, m: Record<string, unknown>, ev: MrEvent, app: AppState) {
  const type = m.type as string;
  if (type === "rate_limit_event") {
    const info = m.rate_limit_info as { unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }> } | undefined;
    const w = info?.unifiedWindows ?? {};
    const wk = w.seven_day ?? w.weekly;
    app.usage = { fiveHour: w.five_hour?.utilization ?? app.usage.fiveHour, weekly: wk?.utilization ?? app.usage.weekly, resetsAt: w.five_hour?.resetsAt ?? app.usage.resetsAt, weeklyResetsAt: wk?.resetsAt ?? app.usage.weeklyResetsAt };
    return;
  }
  if (type === "assistant") {
    const content = ((m.message as { content?: unknown[] })?.content ?? []) as Record<string, unknown>[];
    const add: TranscriptItem[] = [];
    for (const [i, c] of content.entries()) {
      if (c.type === "text" && String(c.text ?? "").trim()) add.push({ kind: "text", id: `${ev.id}:${i}`, text: String(c.text), at: ev.created_at });
      if (c.type === "tool_use") {
        const input = (c.input ?? {}) as Record<string, unknown>;
        add.push({ kind: "tool", id: `${ev.id}:${i}`, toolUseId: String(c.id ?? ""), name: String(c.name), input, at: ev.created_at });
        if (c.name === "TodoWrite" && Array.isArray(input.todos)) s.todos = input.todos as Todo[];
        trackFile(s, String(c.name), input, ev.created_at);
      }
    }
    // Context in use: what this reply read (fresh, cached, newly cached) plus what it wrote. Subagents run their own.
    const u = (m.message as { usage?: Record<string, number> })?.usage;
    // An expired or missing sign-in comes back as a synthetic reply, not a session error (MR-153).
    if (m.error === "authentication_failed") s.signedOut = { retry: [...s.transcript].reverse().find((t) => t.kind === "user")?.text || "Continue where you left off." };
    else if (!m.parent_tool_use_id) s.signedOut = null;
    if (u && !m.parent_tool_use_id) s.context = { ...s.context, used: ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens"].reduce((n, k) => n + Number(u[k] ?? 0), 0) };
    // A new turn starts with whatever was waiting for it.
    if (!s.turnOpen) s.transcript = settle(s.transcript, ["sending", "queued"], "taken");
    s.turnOpen = true;
    s.transcript = [...s.transcript, ...add];
    if (s.status !== "needs_you") s.status = "working";
    return;
  }
  if (type === "active_goal") {
    // Set, re-checked (not met yet) or cleared (met, /goal clear, an error): the full value each time.
    const g = m.value as { condition?: unknown; iterations?: unknown; set_at?: unknown; last_reason?: unknown } | null;
    s.goal = g && typeof g.condition === "string" ? { condition: g.condition, iterations: Number(g.iterations ?? 0), setAt: Number(g.set_at ?? ev.created_at), lastReason: typeof g.last_reason === "string" ? g.last_reason : null } : null;
    return;
  }
  if (type === "user") {
    // Claude Code hands mid-turn messages over with the next tool result.
    s.transcript = settle(s.transcript, ["sending", "queued"], "taken");
    const content = ((m.message as { content?: unknown })?.content ?? []) as unknown;
    if (Array.isArray(content)) {
      for (const c of content as Record<string, unknown>[]) {
        if (c.type !== "tool_result") continue;
        const id = String(c.tool_use_id ?? "");
        s.transcript = s.transcript.map((t) => (t.kind === "tool" && t.toolUseId === id ? { ...t, result: m.tool_use_result ?? c.content, isError: Boolean(c.is_error), ...(t.background && { background: { ...t.background, output: t.background.output ?? outputFile(c.content) } }) } : t));
      }
    }
    return;
  }
  if (type === "system" && m.subtype === "init") {
    // Names only; the sidecar follows up with descriptions (sidecar.commands). MCP: status as of start.
    const names = (k: string) => (Array.isArray(m[k]) ? (m[k] as unknown[]).map(String) : []);
    const skills = new Set(names("skills")), terminal = new Set(names("terminal_slash_commands"));
    if (!s.commands.length) s.commands = names("slash_commands").map((name) => ({ name, description: "", hint: "", aliases: [], builtin: false, skill: skills.has(name), terminal: terminal.has(name) }));
    const servers = Array.isArray(m.mcp_servers) ? (m.mcp_servers as { name?: unknown; status?: unknown; source?: unknown }[]) : [];
    if (servers.length) s.mcp = { servers: servers.map((x) => ({ name: String(x.name ?? ""), status: String(x.status ?? ""), source: x.source ? String(x.source) : null, scope: null, error: null, version: null, url: null, tools: [] })), at: ev.created_at, busy: null, done: null, error: null };
    return;
  }
  if (type === "system" && m.subtype === "compact_boundary") {
    const post = (m.compact_metadata as { post_tokens?: number } | undefined)?.post_tokens;
    s.context = { ...s.context, used: typeof post === "number" ? post : null };
    return;
  }
  if (type === "system" && m.subtype === "commands_changed" && Array.isArray(m.commands)) {
    // Skills found mid-session: the list is replaced; what we knew about each name is kept.
    const was = new Map(s.commands.map((c) => [c.name, c]));
    s.commands = (m.commands as { name: string; description?: string; argumentHint?: string; aliases?: string[]; builtin?: boolean }[]).map((c) => ({ name: c.name, description: c.description ?? "", hint: c.argumentHint ?? "", aliases: c.aliases ?? [], builtin: !!c.builtin, skill: was.get(c.name)?.skill ?? !c.builtin, terminal: was.get(c.name)?.terminal ?? false }));
    return;
  }
  if (type === "system" && m.subtype === "background_tasks_changed" && Array.isArray(m.tasks)) {
    // The full list each time: what is still running in the background after the turn.
    s.backgroundTasks = (m.tasks as { task_id?: string; description?: string }[]).map((t) => ({ id: String(t.task_id ?? ""), description: String(t.description ?? "") }));
    return;
  }
  if (type === "system" && (m.subtype === "task_started" || m.subtype === "task_notification")) {
    // A backgrounded command or agent: its tool result comes back at once ("running in background"),
    // so the task events are what say it's still going, and how it ended.
    const id = String(m.tool_use_id ?? "");
    s.transcript = s.transcript.map((t) => {
      if (t.kind !== "tool" || t.toolUseId !== id) return t;
      if (m.subtype === "task_started") return m.is_backgrounded ? { ...t, background: { status: "running", from: ev.created_at } } : t;
      return t.background ? { ...t, background: { ...t.background, status: String(m.status ?? "completed"), summary: (m.summary as string) ?? undefined, output: (m.output_file as string) ?? t.background.output, to: ev.created_at } } : t;
    });
    return;
  }
  if (type === "result") {
    const ok = !m.is_error;
    s.costUsd += Number(m.total_cost_usd ?? 0);
    // The session's own model is the one that cost the most this turn; side calls (titles, haiku) cost little.
    const main = Object.values((m.modelUsage ?? {}) as Record<string, { costUSD?: number; contextWindow?: number }>).sort((a, b) => Number(b.costUSD ?? 0) - Number(a.costUSD ?? 0))[0];
    if (main?.contextWindow) s.context = { ...s.context, window: main.contextWindow };
    s.turnOpen = false;
    s.transcript = settle(s.transcript, ["taken"], "answered");
    s.transcript = [...s.transcript, { kind: "result", id: ev.id, ok, text: String(m.result ?? ""), costUsd: Number(m.total_cost_usd ?? 0), at: ev.created_at }];
    // Turn finished: waiting for the next message, unless one is already queued for the next turn.
    if (s.status !== "needs_you") s.status = s.transcript.some((t) => t.kind === "user" && t.delivery === "queued") ? "working" : "idle";
  }
}

// Where a background task writes its output: its tool result says "Output is being written to: <path>.output".
function outputFile(content: unknown): string | undefined {
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => (c as { text?: string })?.text ?? "").join("\n") : "";
  return /written to: (\S+\.output)/.exec(text)?.[1];
}

function settle(items: TranscriptItem[], from: Delivery[], to: Delivery): TranscriptItem[] {
  return items.some((t) => t.kind === "user" && t.delivery && from.includes(t.delivery))
    ? items.map((t) => (t.kind === "user" && t.delivery && from.includes(t.delivery) ? { ...t, delivery: to } : t))
    : items;
}

function trackFile(s: SessionState, tool: string, input: Record<string, unknown>, at: number) {
  const path = String(input.file_path ?? input.notebook_path ?? "");
  if (!path) return;
  const prev: FileChange = s.files[path] ?? { path, added: 0, removed: 0, isNew: false, lastAt: at };
  let { added, removed, isNew } = prev;
  if (tool === "Write") { added += lines(input.content); isNew = isNew || !s.files[path]; }
  else if (tool === "Edit") { added += lines(input.new_string); removed += lines(input.old_string); }
  else if (tool === "MultiEdit" && Array.isArray(input.edits)) for (const e of input.edits as Record<string, unknown>[]) { added += lines(e.new_string); removed += lines(e.old_string); }
  else return;
  s.files = { ...s.files, [path]: { path, added, removed, isNew, lastAt: at } };
}

export function replay(events: MrEvent[], from: AppState = initialState): AppState {
  return events.reduce(reduce, from);
}

function reviewStep(r: SessionState["review"], kind: string, p: Record<string, unknown>): NonNullable<SessionState["review"]> {
  const f = r ?? { snippets: {}, current: null, noted: [] };
  if (kind === "flow.review_overview") return { ...f, overview: p as never };
  if (kind === "flow.review_snippet") { const n = Number(p.n ?? 0); return { ...f, snippets: { ...f.snippets, [n]: { ...(p as object), n } as never }, current: n }; }
  if (kind === "flow.review_publish_ready") return { ...f, publish: p as never, current: null };
  if (kind === "flow.review_unchanged") return { ...f, unchanged: p as never };
  if (kind === "flow.review_published") return { ...f, published: true, approved: p.approved === true || !!f.approved, current: null };
  if (kind === "ui.review_noted") { const id = String(p.finding_id); return { ...f, noted: f.noted.includes(id) ? f.noted : [...f.noted, id] }; }
  if (kind === "ui.review_unnoted") { const id = String(p.finding_id); return { ...f, noted: f.noted.filter((x) => x !== id) }; }
  return f;
}

function addressStep(a: SessionState["address"], kind: string, p: Record<string, unknown>): NonNullable<SessionState["address"]> {
  const f = a ?? { threads: {}, proofs: {}, replies: {}, current: null, chosen: {} };
  const id = String(p.id ?? "");
  if (kind === "flow.address_threads") return { ...f, list: p as never };
  // Every thread is drawn up front (MR-126): drawing one isn't working on it, address_fixing is.
  if (kind === "flow.address_thread") return { ...f, threads: { ...f.threads, [id]: p as never } };
  if (kind === "flow.address_fixing") return { ...f, current: id };
  if (kind === "flow.address_proof") return { ...f, proofs: { ...f.proofs, [id]: (p.checks ?? []) as never } };
  if (kind === "flow.address_reply") return { ...f, replies: { ...f.replies, [id]: p as never }, current: f.current === id && p.posted ? null : f.current };
  if (kind === "flow.address_done") return { ...f, done: p as never, current: null };
  if (kind === "ui.address_chosen") return { ...f, chosen: { ...f.chosen, [id]: String(p.option) } };
  return f;
}

/** Where a new session in this workspace starts (MR-65): its pinned folder, else the folder its
 *  latest session ran in, else null (the picker's own fallback). */
// The intro is open on first run (after the replay) and again after each Settings → Show the intro,
// even when it was closed earlier in this run (closedAt = the last event id when it closed).
export function introOpen(state: AppState, closedAt: string | null): boolean {
  if (state.lastEventId === null || state.onboarded) return false;
  return closedAt === null || (state.onboardingResetAt !== null && state.onboardingResetAt > closedAt);
}

export function workspaceFolder(state: AppState, ws: string): string | null {
  const pinned = state.workspaces.find((w) => w.id === ws)?.folder;
  if (pinned) return pinned;
  const last = [...state.order].reverse().map((id) => state.sessions[id]).find((s) => s.workspace === ws && !s.fromDeleted && (s.kind === "blank" || s.kind === "plan"));
  return last ? last.repo ?? last.cwd : null;
}

/** How full a session's context is against where it auto-compacts: the Compact-at setting or the model's window, whichever is smaller. */
export function contextFill(s: SessionState, compactWindow: number | null): { used: number; limit: number; share: number } | null {
  if (s.context.used === null) return null;
  const limit = Math.min(compactWindow ?? Infinity, s.context.window ?? Infinity);
  return Number.isFinite(limit) ? { used: s.context.used, limit, share: s.context.used / limit } : null;
}

// A message's attachments from its logged payload, when it has any.
function attached(p: Record<string, unknown>): { attachments?: Attachment[] } {
  const a = Array.isArray(p.attachments) ? (p.attachments as Record<string, unknown>[]).filter((x) => typeof x?.path === "string") : [];
  return a.length ? { attachments: a.map((x) => ({ path: String(x.path), name: String(x.name ?? x.path), mime: String(x.mime ?? ""), ...(typeof x.size === "number" && { size: x.size }) })) } : {};
}
