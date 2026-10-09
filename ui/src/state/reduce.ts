import type { AppState, FileChange, MrEvent, PendingAsk, SessionKind, SessionState, Todo, TranscriptItem } from "./types";

export const initialState: AppState = {
  sessions: {},
  order: [],
  usage: { fiveHour: null, weekly: null, resetsAt: null },
  sidecar: { up: false, claude: null },
  lastEventId: null,
};

function newSession(id: string, at: number, title = "", cwd = "", kind: SessionKind = "blank"): SessionState {
  return {
    id, kind, title, cwd, sdkSessionId: null, model: null, status: "starting", startedAt: at, lastActivity: at,
    pending: [], transcript: [], todos: [], files: {}, activity: new Array(30).fill(0), costUsd: 0, error: null,
  };
}

const lines = (s: unknown) => (typeof s === "string" && s.length ? s.split("\n").length : 0);

// Replays one event onto the state. Pure: the same log always yields the same state.
export function reduce(state: AppState, ev: MrEvent): AppState {
  const p = ev.payload;
  const next: AppState = { ...state, lastEventId: ev.id };
  const sid = ev.session_id;

  if (ev.kind === "sidecar.ready") return { ...next, sidecar: { up: true, claude: (p.claude as string) ?? null } };
  if (ev.kind === "sidecar.terminated") return { ...next, sidecar: { up: false, claude: state.sidecar.claude } };

  if (ev.kind === "ui.session_requested" && sid) {
    const kind = (["review", "address", "plan", "blank"].includes(String(p.kind)) ? p.kind : "blank") as SessionKind;
    const existing = next.sessions[sid];
    if (existing) return { ...next, sessions: { ...next.sessions, [sid]: { ...existing, kind, title: existing.title || String(p.prompt ?? ""), cwd: existing.cwd || String(p.cwd ?? "") } } };
    return { ...next, sessions: { ...next.sessions, [sid]: newSession(sid, ev.created_at, String(p.prompt ?? ""), String(p.cwd ?? ""), kind) }, order: [...next.order, sid] };
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
    case "ui.message_sent":
      s.transcript = [...s.transcript, { kind: "user", id: ev.id, text: String(p.text ?? ""), at: ev.created_at }];
      s.status = "working";
      break;
    case "sidecar.sdk":
      applySdk(s, p.message as Record<string, unknown>, ev, next);
      break;
    case "sidecar.session_ended":
      s.status = p.ok ? "ended" : "error";
      s.error = p.ok ? null : String(p.reason ?? "session failed");
      s.pending = [];
      break;
  }
  return { ...next, sessions: { ...next.sessions, [sid]: s }, order };
}

function bump(s: SessionState, at: number): number[] {
  // 30 one-minute buckets ending at the session's latest activity.
  const shift = Math.max(0, Math.floor((at - s.lastActivity) / 60000));
  const a = shift >= 30 ? new Array(30).fill(0) : [...s.activity.slice(shift), ...new Array(shift).fill(0)];
  a[29] += 1;
  return a;
}

function applySdk(s: SessionState, m: Record<string, unknown>, ev: MrEvent, app: AppState) {
  const type = m.type as string;
  if (type === "rate_limit_event") {
    const info = m.rate_limit_info as { unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }> } | undefined;
    const w = info?.unifiedWindows ?? {};
    app.usage = { fiveHour: w.five_hour?.utilization ?? app.usage.fiveHour, weekly: (w.seven_day ?? w.weekly)?.utilization ?? app.usage.weekly, resetsAt: w.five_hour?.resetsAt ?? app.usage.resetsAt };
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
    s.transcript = [...s.transcript, ...add];
    if (s.status !== "needs_you") s.status = "working";
    return;
  }
  if (type === "user") {
    const content = ((m.message as { content?: unknown })?.content ?? []) as unknown;
    if (Array.isArray(content)) {
      for (const c of content as Record<string, unknown>[]) {
        if (c.type !== "tool_result") continue;
        const id = String(c.tool_use_id ?? "");
        s.transcript = s.transcript.map((t) => (t.kind === "tool" && t.toolUseId === id ? { ...t, result: m.tool_use_result ?? c.content, isError: Boolean(c.is_error) } : t));
      }
    }
    return;
  }
  if (type === "result") {
    const ok = !m.is_error;
    s.costUsd += Number(m.total_cost_usd ?? 0);
    s.transcript = [...s.transcript, { kind: "result", id: ev.id, ok, text: String(m.result ?? ""), costUsd: Number(m.total_cost_usd ?? 0), at: ev.created_at }];
    if (s.status !== "needs_you") s.status = "idle"; // turn finished; waiting for the next message
  }
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
