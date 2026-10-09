import { useEffect, useReducer } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { initialState, reduce, replay } from "./reduce";
import type { AppState, MrEvent } from "./types";

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
  start: (cwd: string, prompt: string) => invoke<string>("session_start", { cwd, prompt }),
  send: (session: string, text: string) => invoke("session_send", { session, text }),
  interrupt: (session: string) => invoke("session_interrupt", { session }),
  stop: (session: string) => invoke("session_stop", { session }),
  respond: (session: string, requestId: string, decision: Record<string, unknown>) => invoke("permission_respond", { session, requestId, decision }),
  log: (kind: string, payload: Record<string, unknown>, sessionId?: string, anchor?: string) => invoke("event_append", { sessionId, kind, payload, anchor }),
};
