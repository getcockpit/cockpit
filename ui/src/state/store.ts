import { useEffect, useReducer } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "./listen";
import { initialState, reduce, replay } from "./reduce";
import type { AppState, Attachment, MrEvent, PermissionMode } from "./types";
import type { McpAddConfig, McpScope } from "../components/mcpAdd";

export type Pr = { number: number; title: string; url: string; updatedAt: string; author?: { login: string }; repository?: { nameWithOwner: string }; reviewDecision?: string; isDraft?: boolean; unresolved?: number; waiting?: number; reviewNote?: string };

type Action = { type: "replay"; events: MrEvent[] } | { type: "event"; event: MrEvent } | { type: "instance"; id: string } | { type: "hydrate"; id: string; events: MrEvent[] };

export function reducer(state: AppState, a: Action): AppState {
  if (a.type === "instance") return { ...state, instance: a.id };
  if (a.type === "replay") return markPartial(replay(a.events, { ...initialState, instance: state.instance }));
  if (a.type === "hydrate") return hydrated(state, a.id, a.events);
  return reduce(state, a.event);
}

// The boot read skips archived sessions' transcripts (MR-162), so every archived session starts partial.
function markPartial(state: AppState): AppState {
  const sessions = Object.fromEntries(Object.entries(state.sessions).map(([k, s]) => [k, s.archivedAt ? { ...s, partial: true } : s]));
  return { ...state, sessions };
}

/** A partial session rebuilt from its full history (its own rows plus the app-wide ones, in order). */
export function hydrated(state: AppState, id: string, events: MrEvent[]): AppState {
  const was = state.sessions[id];
  if (!was) return state;
  const full = replay(events, { ...initialState, instance: state.instance }).sessions[id] ?? was;
  return { ...state, sessions: { ...state.sessions, [id]: { ...full, partial: false } } };
}

// Asks the mounted store to load a partial session's full history; set by useAppState.
let requestHydrate: (id: string) => void = () => {};
export const hydrate = (id: string) => requestHydrate(id);

// Live events can race the initial replay, and rows from another copy of the app (MR-99) can come
// in after newer ones of ours, so repeats are dropped by id rather than by order.
export function dedupe() {
  let seen = new Set<string>();
  return {
    replayed(events: MrEvent[]) {
      const recent = (events.at(-1)?.created_at ?? 0) - 60_000;
      for (const e of events) if (e.created_at >= recent) seen.add(e.id);
    },
    fresh(e: MrEvent): boolean {
      if (seen.has(e.id)) return false;
      if (seen.size > 20_000) seen = new Set();
      seen.add(e.id);
      return true;
    },
  };
}

// The whole log, a page at a time. One capped read silently dropped every event past the cap,
// so after a restart the newest sessions came back without their history (MR-97).
const PAGE = 5000;
// Archived sessions come without their transcripts: those were 99% of the log (MR-162).
export async function loadLog(list = (args: { after: string | null; limit: number; skipArchived: boolean }) => invoke<MrEvent[]>("events_list", args)): Promise<MrEvent[]> {
  const all: MrEvent[] = [];
  for (let after: string | null = null; ; ) {
    const page = await list({ after, limit: PAGE, skipArchived: true });
    all.push(...page);
    if (page.length < PAGE) return all;
    after = page[page.length - 1].id;
  }
}

// The app's single source of truth: replay the log on boot, then apply live events.
export function useAppState(): AppState {
  const [state, dispatch] = useReducer(reducer, initialState);
  useEffect(() => {
    let alive = true;
    const pending: MrEvent[] = [];
    let replayed = false;
    const seen = dedupe();
    // Live rows for a session whose history is loading: the read may or may not include them.
    const loading = new Map<string, MrEvent[]>();
    const un = listen<MrEvent>("mr-event", ({ payload }) => {
      if (!replayed) pending.push(payload);
      else if (seen.fresh(payload)) {
        if (payload.session_id) loading.get(payload.session_id)?.push(payload);
        dispatch({ type: "event", event: payload });
      }
    });
    requestHydrate = (id) => {
      if (loading.has(id)) return;
      loading.set(id, []);
      invoke<MrEvent[]>("events_session", { sessionId: id }).then((events) => {
        const have = new Set(events.map((e) => e.id));
        if (alive) dispatch({ type: "hydrate", id, events: [...events, ...(loading.get(id) ?? []).filter((e) => !have.has(e.id))] });
      }).catch(() => {}).finally(() => loading.delete(id));
    };
    // Which copy this is comes first: the replay needs it to tell this copy's sessions from others'.
    invoke<string>("instance_id").catch(() => null).then((id) => {
      if (id && alive) dispatch({ type: "instance", id });
      return loadLog();
    }).then((events) => {
      if (!alive) return;
      dispatch({ type: "replay", events });
      seen.replayed(events);
      replayed = true;
      for (const e of pending) if (seen.fresh(e)) dispatch({ type: "event", event: e });
    });
    return () => { alive = false; requestHydrate = () => {}; un.then((f) => f()); };
  }, []);
  // A restored session is back on the wall: give it its history.
  useEffect(() => {
    for (const s of Object.values(state.sessions)) if (s.partial && !s.archivedAt) hydrate(s.id);
  }, [state.sessions]);
  return state;
}

// Only what the core and sidecar need of an attachment.
const wire = (a?: Attachment[]) => (a?.length ? a.map(({ path, name, mime, size }) => ({ path, name, mime, size })) : undefined);

export const api = {
  fixApply: (session: string) => invoke<string>("fix_apply", { session }),
  mineWorktree: () => invoke<{ worktree: string }>("personal_history").then((h) => h.worktree),
  report: (el?: HTMLElement) => window.dispatchEvent(new CustomEvent("mr:report", { detail: el })),
  /** Mark done: stop it if it's still open in the sidecar (frees a slot), then move it to the archive. */
  archive: async (s: { id: string; status: string }) => {
    if (!["ended", "error", "interrupted"].includes(s.status)) await invoke("session_stop", { session: s.id }).catch(() => {});
    await invoke("event_append", { sessionId: s.id, kind: "ui.session_archived", payload: {} });
  },
  refreshLimits: () => invoke("limits_refresh"),
  diagram: (session: string, itemId: string, text: string) => invoke("layer3_diagram", { session, itemId, text }),
  classify: (session: string, itemId: string, text: string) => invoke("layer2_classify", { session, itemId, text }),
  layer2Status: () => invoke<{ configured: boolean }>("layer2_status"),
  layer2Save: (accountId: string, apiToken: string) => invoke("layer2_save_credentials", { accountId, apiToken }),
  cockpitStatus: () => invoke<{ configured: boolean }>("cockpit_status"),
  cockpitSaveKey: (key: string) => invoke("cockpit_save_key", { key }),
  start: (cwd: string, prompt: string, kind: string = "blank", worktree?: boolean, workspace?: string, preset?: string, attachments?: Attachment[]) => invoke<string>("session_start", { cwd, prompt, kind, worktree, workspace: workspace ?? currentWorkspace(), preset, attachments: wire(attachments) }),
  resume: (s: { id: string; cwd: string; kind: string; sdkSessionId: string | null }) =>
    invoke<string>("session_start", { cwd: s.cwd, prompt: "Continue where you left off. Say briefly where things stand first.", kind: s.kind, resume: s.sdkSessionId, worktree: false, sessionId: s.id }),
  // Every repo by default (MR-48); `repo` ("owner/name") keeps one (MR-79).
  prs: (cwd: string, mode: "review" | "address", repo?: string) => invoke<Pr[]>("gh_prs", { cwd, mode, repo }),
  ghRepo: (cwd: string) => invoke<string | null>("gh_repo", { cwd }),
  reviewState: (url: string) => invoke<unknown>("gh_review_state", { url }),
  // Every message you send is acknowledged on screen right away (MR-58), then the session shows it's working.
  send: (session: string, text: string, attachments?: Attachment[]) => {
    const files = attachments?.length ? ` + ${attachments.length} file${attachments.length > 1 ? "s" : ""}` : "";
    window.dispatchEvent(new CustomEvent("mr:toast", { detail: `Sent: ${text.length > 60 ? `${text.slice(0, 57)}…` : text}${files}` }));
    return invoke("session_send", { session, text, attachments: wire(attachments) }).catch((e) => { window.dispatchEvent(new CustomEvent("mr:toast", { detail: `Not sent: ${String(e).split("\n")[0]}` })); throw e; });
  },
  // Signed back in (MR-153): the refused message again, in a fresh Claude Code process that reads the new login.
  retrySignedIn: (session: string, text: string) => invoke("session_retry_signed_in", { session, text }).catch((e) => { window.dispatchEvent(new CustomEvent("mr:toast", { detail: `Not sent: ${String(e).split("\n")[0]}` })); throw e; }),
  // Model and effort for one session (MR-73): null goes back to Claude Code's default, a missing key leaves it.
  setModel: (session: string, change: { model?: string | null; effort?: string | null }) => invoke("session_set_model", { session, change }),
  modelsRefresh: () => invoke("models_refresh"),
  // How sessions ask before using tools (I106): logged, then switched on every running session.
  setPermissionMode: (mode: PermissionMode) => invoke("permission_mode_set", { mode }),
  interrupt: (session: string) => invoke("session_interrupt", { session }),
  // Files for the message box: pasted bytes are saved under the data folder; dropped or picked
  // paths are described (type, size); an image's bytes come back for its thumbnail.
  attachmentSave: async (blob: Blob, name: string) => invoke<Attachment>("attachment_save", new Uint8Array(await blob.arrayBuffer()), { headers: { "x-name": encodeURIComponent(name) } }),
  attachmentInfo: (paths: string[]) => invoke<(Attachment & { dir: boolean; exists: boolean })[]>("attachment_info", { paths }),
  attachmentRead: (path: string) => invoke<ArrayBuffer>("attachment_read", { path }),
  // Slash commands and /mcp (MR-87): answers arrive as sidecar.commands / sidecar.mcp_status.
  commands: (session: string) => invoke("session_commands", { session }),
  mcpStatus: (session: string) => invoke("session_mcp_status", { session }),
  // @ mentions (MR-108): the files and folders in a session's folder, folders ending in /.
  paths: (cwd: string) => invoke<string[]>("session_paths", { cwd }),
  mcpAction: (session: string, server: string, action: "reconnect" | "enable" | "disable") => invoke("session_mcp_action", { session, server, action }),
  // Saved with `claude mcp add-json` in scope, then attached to the running session.
  mcpAdd: (session: string, server: string, scope: McpScope, config: McpAddConfig) => invoke("session_mcp_add", { session, server, scope, config }),
  // A command from a reply's Run button (MR-85): runs in the session's folder, listed in its side panel.
  run: (session: string, cwd: string, command: string) => {
    window.dispatchEvent(new CustomEvent("mr:toast", { detail: `Running: ${command.length > 60 ? `${command.slice(0, 57)}…` : command}` }));
    return invoke<string>("run_command", { session, cwd, command }).catch((e) => { window.dispatchEvent(new CustomEvent("mr:toast", { detail: `Didn't run: ${String(e).split("\n")[0]}` })); throw e; });
  },
  runStop: (session: string, runId: string) => invoke("run_stop", { session, runId }),
  stop: (session: string) => invoke("session_stop", { session }),
  /** Into another workspace, conversation and all (MR-154). */
  move: (session: string, workspace: string) => invoke("session_move", { session, workspace }),
  respond: (session: string, requestId: string, decision: Record<string, unknown>) => invoke("permission_respond", { session, requestId, decision }),
  log: (kind: string, payload: Record<string, unknown>, sessionId?: string, anchor?: string) => invoke("event_append", { sessionId, kind, payload, anchor }),
};

// The active workspace tab (a per-viewer convenience; the data itself lives in the event log).
export function currentWorkspace(): string {
  try { return localStorage.getItem("mr.workspace") ?? "personal"; } catch { return "personal"; }
}
