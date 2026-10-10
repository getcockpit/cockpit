import { needsQueue } from "../picker/queue";
import { useEffect, useMemo, useState } from "react";
import { keyOf } from "../components/keys";
import { invoke } from "@tauri-apps/api/core";
import type { Doc } from "../state/docs";
import type { AppState } from "../state/types";

/** How many things wait on you in one workspace (the same queue the wall shows). */
export function needsIn(state: AppState, docs: Doc[], ws: string): number {
  const sessions = Object.values(state.sessions).filter((x) => x.workspace === ws);
  const ids = new Set(sessions.map((x) => x.id));
  return needsQueue(sessions, docs.filter((d) => (d.session_id ? ids.has(d.session_id) : ws === "personal"))).length;
}

// Workspace tabs (decision 24). A background tab shows how many things need you in it.
export function WorkspaceTabs({ state, docs, active, onSwitch, onSignIn, onSettings, onSwitcher }: { state: AppState; docs: Doc[]; active: string; onSwitch: (id: string) => void; onSignIn: (id: string) => void; onSettings: () => void; onSwitcher: () => void }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const needs = (ws: string) => needsIn(state, docs, ws);
  const loggedOut = (ws: string) => Object.values(state.sessions).some((s) => s.workspace === ws && /not logged in|\/login/i.test(s.error ?? "") );
  const create = async () => {
    if (!name.trim()) return;
    const id = await invoke<string>("workspace_create", { name: name.trim() });
    setName(""); setAdding(false); onSwitch(id); onSignIn(id);
  };
  return (
    <nav aria-label="Workspaces" className="mr-row" style={{ gap: 2, padding: "0 12px", background: "var(--mr-ink)", minHeight: 36 }}>
      {state.workspaces.map((w, i) => {
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
            {i < 9 && <kbd className="mr-mono" style={{ fontSize: 11, opacity: 0.55 }}>⌘{i + 1}</kbd>}
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
      {state.workspaces.length > 1 && <button type="button" onClick={onSwitcher} title="Switch workspace (⌃Tab cycles)" style={{ padding: "6px 10px", border: 0, background: "transparent", color: "var(--mr-well)", cursor: "pointer", font: "inherit" }}>Switch <span className="mr-mono">⌘J</span></button>}
      <button type="button" onClick={onSettings} style={{ padding: "6px 10px", border: 0, background: "transparent", color: "var(--mr-well)", cursor: "pointer", font: "inherit" }}>Settings <span className="mr-mono">⌘,</span></button>
    </nav>
  );
}

// ⌘J quick switcher (MR-55): every workspace with what's waiting in it; type to filter, ↵ to go.
export function WorkspaceSwitcher({ state, docs, active, onSwitch, onClose }: { state: AppState; docs: Doc[]; active: string; onSwitch: (id: string) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const list = useMemo(() => state.workspaces.map((w, i) => ({ w, i, n: needsIn(state, docs, w.id), running: Object.values(state.sessions).filter((s) => s.workspace === w.id && !s.archivedAt && (s.status === "working" || s.status === "starting")).length }))
    .filter((x) => !q.trim() || x.w.name.toLowerCase().includes(q.trim().toLowerCase())), [state, docs, q]);
  const [sel, setSel] = useState(0);
  useEffect(() => setSel(0), [q]);
  const go = (id: string) => { onSwitch(id); onClose(); };
  return (
    <div role="dialog" aria-label="Switch workspace" data-mr="WorkspaceSwitcher" style={{ position: "fixed", inset: 0, zIndex: 30, display: "flex", justifyContent: "center", alignItems: "flex-start", padding: "96px 24px", background: "rgba(21,24,27,.35)" }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => {
        const k = keyOf(e);
        if (k === "Escape") { e.preventDefault(); onClose(); }
        if (k === "ArrowDown") { e.preventDefault(); setSel((x) => Math.min(list.length - 1, x + 1)); }
        if (k === "ArrowUp") { e.preventDefault(); setSel((x) => Math.max(0, x - 1)); }
        if (k === "Enter" && list[sel]) { e.preventDefault(); go(list[sel].w.id); }
      }}>
      <div style={{ width: "100%", maxWidth: 480, background: "var(--mr-tile)", display: "flex", flexDirection: "column" }}>
        <input autoFocus className="mr-input" placeholder="Switch to…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter workspaces" style={{ margin: 10, fontSize: 16, background: "var(--mr-well)" }} />
        {list.map((x, i) => (
          <button key={x.w.id} type="button" onClick={() => go(x.w.id)} onMouseEnter={() => setSel(i)} className="mr-row"
            style={{ gap: 10, padding: "10px 14px", border: 0, font: "inherit", textAlign: "left", cursor: "pointer", color: "var(--mr-ink)", background: i === sel ? "var(--mr-well)" : "transparent", boxShadow: i === sel ? "inset 3px 0 0 var(--mr-selected)" : undefined }}>
            <strong className="mr-grow">{x.w.name}{x.w.id === active ? <span className="mr-dim" style={{ fontWeight: 400 }}> · here</span> : null}</strong>
            {x.n > 0 && <span className="mr-mono" style={{ padding: "0 6px", background: "var(--mr-needs)", fontWeight: 700 }}>{x.n} need you</span>}
            {x.running > 0 && <span className="mr-dim">{x.running} running</span>}
            {x.i < 9 && <kbd className="mr-mono mr-dim">⌘{x.i + 1}</kbd>}
          </button>
        ))}
        <div className="mr-row mr-dim" style={{ padding: "8px 14px", background: "var(--mr-band)", fontSize: 12 }}>↑↓ pick · ↵ switch · ⌃Tab next workspace · ⌘1–9 direct</div>
      </div>
    </div>
  );
}
