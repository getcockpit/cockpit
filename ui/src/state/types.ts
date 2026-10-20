// Shapes of the event log rows and of the state derived from them by replay.

export type MrEvent = {
  id: string;
  session_id: string | null;
  kind: string; // sidecar.* (agent) or ui.* (user)
  payload: Record<string, unknown>;
  anchor: string | null;
  created_at: number;
  origin?: string | null; // which running copy of the app wrote it (MR-99); absent in older rows
};

export type SessionStatus = "starting" | "working" | "needs_you" | "idle" | "ended" | "error" | "interrupted";

export type PendingAsk =
  | { kind: "permission"; requestId: string; tool: string; input: Record<string, unknown>; suggestions: unknown[] | null; reason: string | null; at: number }
  | { kind: "question"; requestId: string; questions: Question[]; input: Record<string, unknown>; at: number };

export type Question = { question: string; header: string; options: { label: string; description: string; preview?: string }[]; multiSelect?: boolean };

export type TranscriptItem = (
  | { kind: "text"; id: string; text: string; at: number }
  | { kind: "tool"; id: string; toolUseId: string; name: string; input: Record<string, unknown>; result?: unknown; isError?: boolean; background?: Background; at: number }
  | { kind: "user"; id: string; text: string; at: number; delivery?: Delivery; attachments?: Attachment[]; via?: "doc" } // via: a doc-change note from Cockpit (MR-168)
  | { kind: "view"; id: string; title: string; blocks: ViewBlock[]; at: number }
  | { kind: "result"; id: string; ok: boolean; text: string; costUsd?: number; at: number }
) & { step?: string }; // the plan step in progress when it arrived (MR-69)

// A backgrounded command or agent (run_in_background): it outlives its tool call. output: the file
// Claude Code writes its output to; from/to: when it started and ended.
export type Background = { status: string; summary?: string; output?: string; from?: number; to?: number };

// A command you ran from a reply's Run button (MR-85). output: the run's id, read with run_output.
// lost: the app restarted while it ran, so how it ended wasn't seen.
export type Run = { id: string; command: string; cwd: string; status: "running" | "completed" | "failed" | "stopped" | "lost"; code: number | null; from: number; to: number | null };

// A view Claude composed from the catalog with render_view (decision 26, MR-61). Blocks were
// validated by the core; fields beyond the required ones may be missing.
export type ViewBlock = { type: string } & Record<string, unknown>;

// Where a message you sent is (MR-59): sending → taken (Claude has it) → answered (its turn finished).
// Sent mid-turn it's queued: Claude Code hands it over at the next tool result or turn. Lost: the session ended first.
// A file sent with a message (pasted, dropped or picked): images and PDFs reach Claude as content, the rest by path.
export type Attachment = { path: string; name: string; mime: string; size?: number };

export type Delivery = "sending" | "queued" | "taken" | "answered" | "lost";

export type Todo = { content: string; status: "pending" | "in_progress" | "completed"; activeForm?: string; since?: number; doneAt?: number }; // since: when the step started (plan_set, MR-62); doneAt: when it finished (Timeline, MR-32)

// One stretch of a session in one status (Timeline, MR-32). to: null while it lasts. label: what it waits on.
export type Span = { status: SessionStatus; from: number; to: number | null; label?: string };

export type FileChange = { path: string; added: number; removed: number; isNew: boolean; lastAt: number };

export type ReviewFinding = { id: string; severity: string; at?: string; text: string };
export type ReviewFlow = {
  overview?: { pr?: string; title?: string; tier?: number; tier_label?: string; summary?: string; nodes?: { id?: string; label: string; mark?: string; finding?: string | null }[]; edges?: { from: string; to: string; label?: string | null }[]; novelty?: { label: string; what: string; where?: string }[]; questions?: string[]; prior_threads?: number; total_snippets?: number };
  snippets: Record<number, { n: number; total?: number; area?: string; title?: string; file?: string; code?: string; explain?: string; good?: string; findings?: ReviewFinding[] }>;
  current: number | null;
  noted: string[];
  published?: boolean; // you pressed Publish; the flow is over
  unchanged?: { pr?: string; title?: string; last_review_at?: string; last_review_state?: string; checked?: string }; // nothing new since your last review: skipped
  approved?: boolean; // ...with "Approve on my behalf" ticked
  publish?: { comments?: { severity: string; at?: string; text: string; suggestion?: string }[]; verdict?: string; dropped?: number; note?: string };
};
export type AddressThread = { id: string; at?: string; reviewer?: string; short?: string; state?: string };
export type AddressFlow = {
  list?: { pr?: string; round?: string; moved_commits?: number; threads?: AddressThread[] };
  threads: Record<string, { id: string; reviewer?: string; at?: string; body?: string; verdict?: string; evidence_file?: string; evidence_code?: string; options?: { id: string; label: string; detail?: string; recommended?: boolean }[] }>;
  proofs: Record<string, { label: string; ok: boolean | null; proof?: string }[]>;
  replies: Record<string, { text?: string; sha?: string; posted?: boolean }>;
  current: string | null; // the thread Claude is fixing now (address_fixing)
  chosen: Record<string, string>;
  done?: { summary?: string; pushed?: boolean; next?: { label: string; reply?: string }[] };
};

// A slash command or skill a session offers (the / menu, MR-87). terminal: it only works in Claude Code's own terminal.
export type CommandRow = { name: string; description: string; hint: string; aliases: string[]; builtin: boolean; skill: boolean; terminal: boolean };
// One MCP server as /mcp shows it (MR-87).
export type McpServer = { name: string; status: string; source: string | null; scope: string | null; error: string | null; version: string | null; url: string | null; tools: string[] };
// busy: the server an action was just asked for; done: how the last action went.
export type McpState = { servers: McpServer[]; at: number; busy: string | null; done: { server: string; action: string; ok: boolean; error?: string } | null; error: string | null };

export type SessionKind = "review" | "address" | "plan" | "blank";

// One of your own kinds in the start picker (MR-80): a prompt template, `{text}` is what you type.
export type Preset = { id: string; name: string; template: string; worktree: boolean };

export type SessionState = {
  id: string;
  kind: SessionKind;
  preset: string | null; // started from one of your own kinds (MR-80)
  workspace: string;
  title: string; // the first prompt
  name: string | null; // your rename: always wins (MR-63)
  autoTitle: string | null; // what Claude says the thread is about now (title_set, MR-63)
  cwd: string;
  repo: string | null;
  branch: string | null;
  sdkSessionId: string | null;
  model: string | null; // what Claude Code reports it runs (init), or the alias last switched to
  modelChoice: string | null; // your pick in the model picker (null: Claude Code's default, MR-73)
  effort: string | null; // your effort pick (null: the model's default)
  modelError: string | null; // the last switch Claude Code refused
  status: SessionStatus;
  startedAt: number;
  lastActivity: number;
  heardAt: number; // last event from Claude (sidecar), for "quiet for 1m" (MR-59)
  turnOpen: boolean; // a turn is in flight: a message sent now waits for the next hand-over
  pending: PendingAsk[];
  transcript: TranscriptItem[];
  todos: Todo[];
  runs: Run[]; // commands you ran from Run buttons, oldest first (MR-85)
  files: Record<string, FileChange>;
  activity: number[]; // events per minute, last 30 minutes (sparkline)
  spans: Span[]; // status history, newest last (Timeline, MR-32)
  costUsd: number;
  context: { used: number | null; window: number | null }; // tokens in context after the latest main-thread reply (null: unknown since a compact); window: the model's, from Claude Code's result
  error: string | null;
  review: ReviewFlow | null;
  address: AddressFlow | null;
  diagrams: Record<string, Diagram | null>; // transcript item id → layer-3 diagram (null: nothing worth drawing)
  archivedAt: number | null;
  partial: boolean; // loaded without its transcript at boot (archived, MR-162): its full history loads when opened
  fixApplied: number | null;
  fromDeleted: string | null; // name of the deleted workspace it came from: read-only history (MR-54) // when its fix was applied to your app (MR-47) // a god-mode fix session whose work was applied to your app (MR-47) // marked done: off the wall, into the archive
  commands: CommandRow[]; // its slash commands and skills (MR-87): names from init, descriptions once asked
  mcp: McpState | null; // its MCP servers (MR-87): from init, fresh from /mcp
  owner: string | null; // origin of the copy that last started or resumed it (MR-99)
  backgroundTasks: { id: string; description: string }[]; // commands and agents still running after the turn ended
  goal: Goal | null; // the /goal Claude keeps working toward until an evaluator says it's met
  signedOut: { retry: string } | null; // Claude Code refused a turn because its sign-in expired (MR-153): the message to send again once signed in
  kinds: Record<string, ProseKind>; // transcript item id → what picker layer 2 says that prose is doing
  schedule: string | null; // a recurring run: the schedule that started it (MR-167)
  unread: boolean; // a recurring run you haven't opened yet: marked new on the Wall and in the review tray
};

// A recurring session (MR-167): a saved prompt + folder + cadence that Cockpit starts by itself.
// at: local "HH:MM"; days: 1 = Monday … 7 = Sunday (weekly); every_h (hourly).
// Since MR-169 the editor saves `cron` (minute hour day-of-month month weekday, local time); the older kinds still load.
export type Cadence = { kind: "daily" | "weekdays" | "weekly" | "hourly"; at: string; days?: number[]; every_h?: number } | { kind: "cron"; expr: string };
export type ScheduleRun = { at: number; session: string | null; reason: "due" | "catchup" | "manual"; ok: boolean; error: string | null; slot: string | null };
export type Schedule = { id: string; name: string; prompt: string; cwd: string; workspace: string; worktree: boolean; cadence: Cadence; permissionMode: PermissionMode; paused: boolean; fromSession: string | null; check: string | null; runs: ScheduleRun[] };
/** A schedule's last check (MR-169): kept in the core's memory only, skipped slots aren't logged. */
export type ScheduleCheck = { at: number; outcome: "checking" | "fired" | "busy" | "no" | "same" | "error"; skipped: number; error: string | null };
export type BackgroundMode = "schedules" | "always" | "never";

// Claude Code's /goal (active_goal): the completion condition, how many turns it was checked and found not met, and why.
export type Goal = { condition: string; iterations: number; setAt: number; lastReason: string | null };
export type Diagram = { title?: string | null; nodes: { id: string; label: string; kind: "step" | "decision" | "done" | "risk" }[]; edges: { from: string; to: string; label?: string | null }[] };
export type ProseKind = { label: "question" | "plan" | "done" | "blocked" | "other"; p: number; layer: "model" | "code" };
// Layer-2 calls today (UTC day, when Cloudflare's free allocation resets).
export type ClefMeter = { day: string; calls: number; tokens: number; errors: number };
/** What the Cockpit layer spent this month on its own key (decision 34): the overhead, metered apart from Claude. */
export type CockpitMeter = { month: string; calls: number; tokens: number; usd: number; errors: number };

// A row of the model picker: what Claude Code offers this login (MR-73).
export type ModelRow = { value: string; resolved: string | null; displayName: string; description: string; efforts: string[] };

export type Usage = { fiveHour: number | null; weekly: number | null; resetsAt: number | null; weeklyResetsAt: number | null };

// One-click Update (decision 27, MR-66): the background build of main and what the last update brought.
export type UpdateState = { phase: "idle" | "building" | "ready" | "failed"; step: string | null; log: string | null; subjects: string[]; startedAt: number | null; whatsNew: string[] | null; restarting: string[] | null };

export type AppState = {
  sessions: Record<string, SessionState>;
  order: string[]; // sessions in start order (the wall never reorders by state)
  usage: Usage;
  models: ModelRow[];
  sidecar: { up: boolean; claude: string | null };
  lastEventId: string | null;
  instance: string | null; // this copy's origin id; other copies (dev, /Applications) share the log (MR-99)
  dismissed: string[];
  workspaces: { id: string; name: string; configDir: string | null; folder: string | null }[]; // folder: pinned start folder (MR-65)
  theme: string;
  look: { scale: number; density: "compact" | "default" | "roomy" }; // instant style controls (MR-50)
  presets: Preset[]; // your own kinds in the start picker (MR-80)
  autoReview: boolean; // start /review by itself for PRs waiting on you (MR-72)
  autoReviewRepos: string[]; // owner/name repos auto-review also scans, review requested or not (MR-170)
  reviewStarts: string[]; // `url@head` of every review auto-review or a schedule started (MR-171): both skip these
  notifications: boolean; // macOS notifications for new needs-you items while the app is in the background (MR-94)
  compactWindow: number | null; // sessions auto-compact at this many context tokens; null = the model's limit (I63)
  sessionCap: number; // how many sessions may be mid-turn at once; idle ones don't count (MR-105)
  permissionMode: PermissionMode | null; // how sessions ask before using tools; null = not chosen yet, which runs as auto (I106)
  clef: ClefMeter;
  cockpitLayer: boolean; // cards drawn by the Cockpit layer on its own key, sessions run plain (decision 34)
  cockpit: CockpitMeter;
  account: { checked: boolean; signedIn: boolean; plan: string | null };
  onboarded: boolean;
  onboardingResetAt: string | null; // id of the last Settings → Show the intro
  recovered: { crashedSlot: string; log: string; at: number } | null; // the dev loop rolled back after a crash at start (MR-70)
  lastBuildAt: number | null; // last successful self-build
  selfbuild: { id: string; branch: string; sha: string; phase: "building" | "ready" } | null; // the latest self-build until relaunched or dismissed
  update: UpdateState;
  overviewLayout: Record<string, { x: number; y: number }>; // where each workspace sits on the Overview canvas (decision 40)
  schedules: Record<string, Schedule>; // recurring sessions (MR-167)
  background: BackgroundMode; // when closing the window leaves Cockpit running in the tray (MR-167)
};

export type PermissionMode = "auto" | "acceptEdits" | "default" | "never";
