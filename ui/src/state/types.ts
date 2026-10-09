// Shapes of the event log rows and of the state derived from them by replay.

export type MrEvent = {
  id: string;
  session_id: string | null;
  kind: string; // sidecar.* (agent) or ui.* (user)
  payload: Record<string, unknown>;
  anchor: string | null;
  created_at: number;
};

export type SessionStatus = "starting" | "working" | "needs_you" | "idle" | "ended" | "error" | "interrupted";

export type PendingAsk =
  | { kind: "permission"; requestId: string; tool: string; input: Record<string, unknown>; suggestions: unknown[] | null; reason: string | null; at: number }
  | { kind: "question"; requestId: string; questions: Question[]; input: Record<string, unknown>; at: number };

export type Question = { question: string; header: string; options: { label: string; description: string; preview?: string }[]; multiSelect?: boolean };

export type TranscriptItem =
  | { kind: "text"; id: string; text: string; at: number }
  | { kind: "tool"; id: string; toolUseId: string; name: string; input: Record<string, unknown>; result?: unknown; isError?: boolean; at: number }
  | { kind: "user"; id: string; text: string; at: number }
  | { kind: "result"; id: string; ok: boolean; text: string; costUsd?: number; at: number };

export type Todo = { content: string; status: "pending" | "in_progress" | "completed"; activeForm?: string };

export type FileChange = { path: string; added: number; removed: number; isNew: boolean; lastAt: number };

export type ReviewFinding = { id: string; severity: string; at?: string; text: string };
export type ReviewFlow = {
  overview?: { pr?: string; title?: string; tier?: number; tier_label?: string; summary?: string; nodes?: { label: string; mark?: string; finding?: string | null }[]; novelty?: { label: string; what: string; where?: string }[]; questions?: string[]; prior_threads?: number; total_snippets?: number };
  snippets: Record<number, { n: number; total?: number; area?: string; title?: string; file?: string; code?: string; explain?: string; good?: string; findings?: ReviewFinding[] }>;
  current: number | null;
  noted: string[];
  publish?: { comments?: { severity: string; at?: string; text: string; suggestion?: string }[]; verdict?: string; dropped?: number; note?: string };
};
export type AddressThread = { id: string; at?: string; reviewer?: string; short?: string; state?: string };
export type AddressFlow = {
  list?: { pr?: string; round?: string; moved_commits?: number; threads?: AddressThread[] };
  threads: Record<string, { id: string; reviewer?: string; at?: string; body?: string; verdict?: string; evidence_file?: string; evidence_code?: string; options?: { id: string; label: string; detail?: string; recommended?: boolean }[] }>;
  proofs: Record<string, { label: string; ok: boolean | null; proof?: string }[]>;
  replies: Record<string, { text?: string; sha?: string; posted?: boolean }>;
  current: string | null;
  chosen: Record<string, string>;
};

export type SessionKind = "review" | "address" | "plan" | "blank";

export type SessionState = {
  id: string;
  kind: SessionKind;
  workspace: string;
  title: string;
  cwd: string;
  repo: string | null;
  branch: string | null;
  sdkSessionId: string | null;
  model: string | null;
  status: SessionStatus;
  startedAt: number;
  lastActivity: number;
  pending: PendingAsk[];
  transcript: TranscriptItem[];
  todos: Todo[];
  files: Record<string, FileChange>;
  activity: number[]; // events per minute, last 30 minutes (sparkline)
  costUsd: number;
  error: string | null;
  review: ReviewFlow | null;
  address: AddressFlow | null;
  kinds: Record<string, ProseKind>; // transcript item id → what picker layer 2 says that prose is doing
};

export type ProseKind = { label: "question" | "plan" | "done" | "blocked" | "other"; p: number; layer: "model" | "code" };
// Layer-2 calls today (UTC day, when Cloudflare's free allocation resets).
export type ClefMeter = { day: string; calls: number; tokens: number; errors: number };

export type Usage = { fiveHour: number | null; weekly: number | null; resetsAt: number | null };

export type AppState = {
  sessions: Record<string, SessionState>;
  order: string[]; // sessions in start order (the wall never reorders by state)
  usage: Usage;
  sidecar: { up: boolean; claude: string | null };
  lastEventId: string | null;
  dismissed: string[];
  workspaces: { id: string; name: string; configDir: string | null }[];
  theme: string;
  clef: ClefMeter;
};
