import { useEffect, useReducer } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { initialState, reduce, replay } from "./reduce";
import type { AppState, MrEvent } from "./types";

export type Pr = { number: number; title: string; url: string; updatedAt: string; author?: { login: string }; repository?: { nameWithOwner: string }; reviewDecision?: string; isDraft?: boolean; unresolved?: number; waiting?: number };

type Action = { type: "replay"; events: MrEvent[] } | { type: "event"; event: MrEvent };

function reducer(state: AppState, a: Action): AppState {
  if (a.type === "replay") return replay(a.events, initialState);
  // Live events can race the initial replay; skip anything already applied.
  if (state.lastEventId && a.event.id <= state.lastEventId) return state;
  return reduce(state, a.event);
}

// The app's single source of truth: replay the log on boot, then apply live events.
export function useAppState(): AppState {
  const [state, dispatch] = useReducer(reducer, initialState);
  useEffect(() => {
    let alive = true;
    const pending: MrEvent[] = [];
    let replayed = false;
    const un = listen<MrEvent>("mr-event", ({ payload }) => {
      if (!replayed) pending.push(payload);
      else dispatch({ type: "event", event: payload });
    });
    invoke<MrEvent[]>("events_list", { limit: 20000 }).then((events) => {
      if (!alive) return;
      dispatch({ type: "replay", events });
      replayed = true;
      for (const e of pending) dispatch({ type: "event", event: e });
    });
    return () => { alive = false; un.then((f) => f()); };
  }, []);
  return state;
}

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
  start: (cwd: string, prompt: string, kind: string = "blank", worktree?: boolean, workspace?: string) => invoke<string>("session_start", { cwd, prompt, kind, worktree, workspace: workspace ?? currentWorkspace() }),
  resume: (s: { id: string; cwd: string; kind: string; sdkSessionId: string | null }) =>
    invoke<string>("session_start", { cwd: s.cwd, prompt: "Continue where you left off. Say briefly where things stand first.", kind: s.kind, resume: s.sdkSessionId, worktree: false, sessionId: s.id }),
  prs: (cwd: string, mode: "review" | "address") => invoke<Pr[]>("gh_prs", { cwd, mode }),
  // Every message you send is acknowledged on screen right away (MR-58), then the session shows it's working.
  send: (session: string, text: string) => {
    window.dispatchEvent(new CustomEvent("mr:toast", { detail: `Sent: ${text.length > 60 ? `${text.slice(0, 57)}…` : text}` }));
    return invoke("session_send", { session, text }).catch((e) => { window.dispatchEvent(new CustomEvent("mr:toast", { detail: `Not sent: ${String(e).split("\n")[0]}` })); throw e; });
  },
  interrupt: (session: string) => invoke("session_interrupt", { session }),
  stop: (session: string) => invoke("session_stop", { session }),
  respond: (session: string, requestId: string, decision: Record<string, unknown>) => invoke("permission_respond", { session, requestId, decision }),
  log: (kind: string, payload: Record<string, unknown>, sessionId?: string, anchor?: string) => invoke("event_append", { sessionId, kind, payload, anchor }),
};

// The active workspace tab (a per-viewer convenience; the data itself lives in the event log).
export function currentWorkspace(): string {
  try { return localStorage.getItem("mr.workspace") ?? "personal"; } catch { return "personal"; }
}
