// Shapes of the event log rows and of the state derived from them by replay.

export type MrEvent = {
  id: string;
  session_id: string | null;
  kind: string; // sidecar.* (agent) or ui.* (user)
  payload: Record<string, unknown>;
  anchor: string | null;
  created_at: number;
};

export type SessionStatus = "starting" | "working" | "needs_you" | "idle" | "ended" | "error";

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

export type SessionState = {
  id: string;
  title: string;
  cwd: string;
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
};

export type Usage = { fiveHour: number | null; weekly: number | null; resetsAt: number | null };

export type AppState = {
  sessions: Record<string, SessionState>;
  order: string[]; // sessions in start order (the wall never reorders by state)
  usage: Usage;
  sidecar: { up: boolean; claude: string | null };
  lastEventId: string | null;
};
