import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isOpenQuestion, type Doc } from "../state/docs";
import type { AppState } from "../state/types";

// Workspace tabs (decision 24). A background tab shows how many things need you in it.
export function WorkspaceTabs({ state, docs, active, onSwitch, onSignIn, onSettings }: { state: AppState; docs: Doc[]; active: string; onSwitch: (id: string) => void; onSignIn: (id: string) => void; onSettings: () => void }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const needs = (ws: string) => {
    const sessions = Object.values(state.sessions).filter((s) => s.workspace === ws);
    const ids = new Set(sessions.map((s) => s.id));
    return sessions.reduce((a, s) => a + s.pending.length, 0) + docs.filter((d) => (d.session_id ? ids.has(d.session_id) : ws === "personal")).reduce((a, d) => a + Object.values(d.blocks).filter(isOpenQuestion).length, 0);
  };
  const loggedOut = (ws: string) => Object.values(state.sessions).some((s) => s.workspace === ws && /not logged in|\/login/i.test(s.error ?? "") );
  const create = async () => {
    if (!name.trim()) return;
    const id = await invoke<string>("workspace_create", { name: name.trim() });
    setName(""); setAdding(false); onSwitch(id); onSignIn(id);
  };
  return (
    <nav aria-label="Workspaces" className="mr-row" style={{ gap: 2, padding: "0 12px", background: "var(--mr-ink)", minHeight: 36 }}>
      {state.workspaces.map((w) => {
        const n = needs(w.id);
        const on = w.id === active;
        return renaming === w.id ? (
          <form key={w.id} onSubmit={(e) => { e.preventDefault(); void invoke("workspace_rename", { id: w.id, name }); setRenaming(null); }}>
            <input autoFocus className="mr-input" style={{ minHeight: 28, width: 160, fontSize: 13 }} value={name} onChange={(e) => setName(e.target.value)} onBlur={() => setRenaming(null)} aria-label="Workspace name" />
          </form>
        ) : (
          <button key={w.id} type="button" onClick={() => onSwitch(w.id)} onDoubleClick={() => { if (w.id !== "personal") { setRenaming(w.id); setName(w.name); } }}
            className="mr-row" style={{ gap: 8, padding: "8px 14px", border: 0, font: "inherit", cursor: "pointer", background: on ? "var(--mr-band)" : "transparent", color: on ? "var(--mr-ink)" : "var(--mr-well)", fontWeight: on ? 700 : 400 }}
            title={w.configDir ? `Own Claude memory: ${w.configDir}` : "Uses your normal ~/.claude"}>
            {w.name}
            {n > 0 && <span className="mr-mono" style={{ padding: "0 6px", background: "var(--mr-needs)", color: "var(--mr-ink)", fontWeight: 700 }}>{n}</span>}
            {loggedOut(w.id) && <span role="button" tabIndex={0} onClick={(e) => { e.stopPropagation(); onSignIn(w.id); }} style={{ color: "var(--mr-needs)" }}>sign in</span>}
          </button>
        );
      })}
      {adding ? (
        <form onSubmit={(e) => { e.preventDefault(); void create(); }}>
          <input autoFocus className="mr-input" style={{ minHeight: 28, width: 180, fontSize: 13 }} placeholder="New workspace name" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => !name && setAdding(false)} aria-label="New workspace name" />
        </form>
      ) : (
        <button type="button" onClick={() => setAdding(true)} aria-label="New workspace" style={{ padding: "6px 10px", border: 0, background: "transparent", color: "var(--mr-well)", cursor: "pointer", font: "inherit" }}>+</button>
      )}
      <span className="mr-grow" />
      <button type="button" onClick={onSettings} style={{ padding: "6px 10px", border: 0, background: "transparent", color: "var(--mr-well)", cursor: "pointer", font: "inherit" }}>Settings <span className="mr-mono">⌘,</span></button>
    </nav>
  );
}
