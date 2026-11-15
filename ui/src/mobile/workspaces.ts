import type { AppState, SessionState } from "../state/types";

// The phone's workspace switcher (Cockpit Remote): which workspaces to offer and how many
// sessions in each need you. "all" shows every workspace's sessions.
export type WsChip = { id: string; name: string; sessions: number; needs: number };

export function workspaceChips(workspaces: AppState["workspaces"], rows: { s: SessionState; needs: boolean }[]): WsChip[] {
  const chips: WsChip[] = workspaces.map((w) => ({ id: w.id, name: w.name, sessions: 0, needs: 0 }));
  for (const r of rows) {
    const c = chips.find((w) => w.id === r.s.workspace);
    if (!c) continue;
    c.sessions++;
    if (r.needs) c.needs++;
  }
  return [{ id: "all", name: "All", sessions: rows.length, needs: rows.filter((r) => r.needs).length }, ...chips];
}

/** The chosen workspace if it still exists, else "all". */
export const pickWorkspace = (chosen: string | null, workspaces: AppState["workspaces"]) =>
  chosen && workspaces.some((w) => w.id === chosen) ? chosen : "all";
