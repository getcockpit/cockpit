import { needsQueue } from "../picker/queue";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { keyOf } from "../components/keys";
import { keyLabel } from "../platform";
import { shortError } from "../components/ErrorLine";
import { invoke } from "@tauri-apps/api/core";
import { FolderPicker } from "../components/FolderPicker";
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
  const [folderFor, setFolderFor] = useState<{ id: string; name: string } | null>(null);
  const needs = (ws: string) => needsIn(state, docs, ws);
  // Drag a tab to reorder (MR-84). Pointer events, not HTML5 drag: the webview's file drop takes those.
  // The tab follows the pointer, the others slide aside to open its slot, and on drop it glides in.
  // Slots are measured once at press, so nothing flickers as tabs shift under the pointer.
  const [drag, setDrag] = useState<{ id: string; x0: number; dx: number; slots: { id: string; left: number; width: number }[]; from: number; to: number; moved: boolean } | null>(null);
  const [held, setHeld] = useState<string[] | null>(null);
  const tabs = useRef(new Map<string, HTMLElement>());
  const dragged = useRef(false);
  const settle = useRef<{ id: string; left: number } | null>(null);
  const ids = state.workspaces.map((w) => w.id).join(" ");
  useEffect(() => setHeld(null), [ids]);
  const base = held ?? state.workspaces.map((w) => w.id);
  const byId = new Map(state.workspaces.map((w) => [w.id, w]));
  const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const GAP = 2, EASE = "transform 160ms cubic-bezier(.2,.7,.3,1)";
  // FLIP: after the drop re-renders in the new order, start the tab where it was let go and ease it home.
  useLayoutEffect(() => {
    const s = settle.current, el = s && tabs.current.get(s.id);
    settle.current = null;
    if (!s || !el || still) return;
    const delta = s.left - el.getBoundingClientRect().left;
    if (Math.abs(delta) < 1) return;
    el.style.transition = "none";
    el.style.transform = `translateX(${delta}px)`;
    void el.offsetWidth;
    el.style.transition = EASE;
    el.style.transform = "";
  });
  const shift = (id: string): number => {
    if (!drag?.moved) return 0;
    if (id === drag.id) return drag.dx;
    const j = base.indexOf(id), w = drag.slots[drag.from].width + GAP;
    if (drag.from < drag.to && j > drag.from && j <= drag.to) return -w;
    if (drag.to < drag.from && j >= drag.to && j < drag.from) return w;
    return 0;
  };
  // Where a tab will land if dropped now, so ⌘1–9 renumber live during a drag.
  const slot = (id: string, i: number): number => {
    if (!drag?.moved) return i;
    if (id === drag.id) return drag.to;
    return i + Math.sign(shift(id));
  };
  const press = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return;
    const slots = base.map((x) => { const r = tabs.current.get(x)?.getBoundingClientRect(); return { id: x, left: r?.left ?? 0, width: r?.width ?? 0 }; });
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ id, x0: e.clientX, dx: 0, slots, from: base.indexOf(id), to: base.indexOf(id), moved: false });
  };
  const move = (e: React.PointerEvent) => {
    if (!drag) return;
    if (!drag.moved && Math.abs(e.clientX - drag.x0) < 5) return;
    const me = drag.slots[drag.from], first = drag.slots[0], last = drag.slots[drag.slots.length - 1];
    // Kept inside the row of tabs. It takes a neighbour's slot once its leading edge passes that
    // neighbour's middle, so a wide tab can still swap with a narrow one at the end of the row.
    const dx = Math.max(first.left - me.left, Math.min(last.left + last.width - me.width - me.left, e.clientX - drag.x0));
    const l = me.left + dx, r = l + me.width;
    const mid = (x: { left: number; width: number }) => x.left + x.width / 2;
    const to = drag.from + drag.slots.slice(drag.from + 1).filter((x) => mid(x) < r).length - drag.slots.slice(0, drag.from).filter((x) => mid(x) > l).length;
    setDrag({ ...drag, moved: true, dx, to });
  };
  const drop = () => {
    if (!drag) return;
    setDrag(null);
    if (!drag.moved) return;
    dragged.current = true;
    const order = base.filter((x) => x !== drag.id);
    order.splice(drag.to, 0, drag.id);
    settle.current = { id: drag.id, left: drag.slots[drag.from].left + drag.dx };
    if (order.join(" ") !== base.join(" ")) { setHeld(order); void invoke("workspace_reorder", { order }); }
  };
  const loggedOut = (ws: string) => Object.values(state.sessions).some((s) => s.workspace === ws && !s.archivedAt && (!!s.signedOut || /not logged in|\/login/i.test(s.error ?? "")));
  const create = async () => {
    if (!name.trim()) return;
    const id = await invoke<string>("workspace_create", { name: name.trim() });
    setName(""); setAdding(false); onSwitch(id); setFolderFor({ id, name: name.trim() });
  };
  // Second step of creating one (MR-65): where its sessions start. Skippable; then sign in.
  const finish = (folder: string | null) => {
    if (!folderFor) return;
    if (folder) void invoke("workspace_set_folder", { id: folderFor.id, folder });
    onSignIn(folderFor.id); setFolderFor(null);
  };
  return (
    <nav aria-label="Workspaces" className="mr-row mr-tabs-bar" style={{ gap: 2, padding: "0 12px", background: "var(--mr-ink)", minHeight: 36 }}>
      {base.map((wid, i) => {
        const w = byId.get(wid);
        if (!w) return null;
        const n = needs(w.id);
        const on = w.id === active;
        const lifted = !!drag?.moved && drag.id === w.id;
        return renaming === w.id ? (
          <form key={w.id} onSubmit={(e) => { e.preventDefault(); void invoke("workspace_rename", { id: w.id, name }); setRenaming(null); }}>
            <input autoFocus className="mr-input" style={{ minHeight: 28, width: 160, fontSize: 13 }} value={name} onChange={(e) => setName(e.target.value)} onBlur={() => setRenaming(null)} aria-label="Workspace name" />
          </form>
        ) : (
          <button key={w.id} type="button" data-mr="WorkspaceTab" data-mr-source={w.id} ref={(el) => { if (el) tabs.current.set(w.id, el); else tabs.current.delete(w.id); }}
            onClick={() => { if (dragged.current) { dragged.current = false; return; } onSwitch(w.id); }} onDoubleClick={() => { if (w.id !== "personal") { setRenaming(w.id); setName(w.name); } }}
            onPointerDown={(e) => press(e, w.id)} onPointerMove={move} onPointerUp={drop} onPointerCancel={() => setDrag(null)}
            className="mr-row" style={{ gap: 8, padding: "8px 14px", border: 0, font: "inherit", cursor: drag?.moved ? "grabbing" : "pointer", touchAction: "none", background: on || lifted ? "var(--mr-band)" : "transparent", color: on || lifted ? "var(--mr-ink)" : "var(--mr-well)", fontWeight: on ? 700 : 400,
              position: "relative", zIndex: lifted ? 1 : undefined, transform: drag?.moved ? `translateX(${shift(w.id)}px)${lifted ? " translateY(-2px)" : ""}` : undefined, transition: drag?.moved && !lifted && !still ? EASE : undefined, boxShadow: lifted ? "inset 0 -3px 0 var(--mr-selected)" : undefined }}
            title={`${w.configDir ? `Own Claude memory: ${w.configDir}` : "Uses your normal ~/.claude"}${w.folder ? `\nStarts in ${w.folder}` : ""}\nDrag to reorder`}>
            {w.name}
            {slot(w.id, i) < 9 && <kbd className="mr-mono" style={{ fontSize: 11, opacity: 0.55 }}>{keyLabel(`⌘${slot(w.id, i) + 1}`)}</kbd>}
            {n > 0 && <span className="mr-mono" style={{ padding: "0 6px", background: "var(--mr-needs)", color: "var(--mr-ink)", fontWeight: 700 }}>{n}</span>}
            {loggedOut(w.id) && <span role="button" tabIndex={0} onClick={(e) => { e.stopPropagation(); onSignIn(w.id); }} style={{ color: "var(--mr-needs)" }}>sign in</span>}
          </button>
        );
      })}
      {folderFor ? (
        <span className="mr-row" data-mr="WorkspaceFolderStep" data-mr-source={folderFor.id} style={{ gap: 8, color: "var(--mr-well)" }}>
          <span>Start “{folderFor.name}” sessions in</span>
          <FolderPicker value="" onChange={(p) => finish(p)} extra={[...new Set(Object.values(state.sessions).map((x) => x.repo ?? x.cwd))].slice(0, 5)} />
          <button type="button" onClick={() => finish(null)} style={{ padding: "6px 10px", border: 0, background: "transparent", color: "var(--mr-well)", cursor: "pointer", font: "inherit" }}>Skip</button>
        </span>
      ) : adding ? (
        <form onSubmit={(e) => { e.preventDefault(); void create(); }}>
          <input autoFocus className="mr-input" style={{ minHeight: 28, width: 180, fontSize: 13 }} placeholder="New workspace name" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => !name && setAdding(false)} aria-label="New workspace name" />
        </form>
      ) : (
        <button type="button" onClick={() => setAdding(true)} aria-label="New workspace" style={{ padding: "6px 10px", border: 0, background: "transparent", color: "var(--mr-well)", cursor: "pointer", font: "inherit" }}>+</button>
      )}
      <span className="mr-grow" />
      {state.workspaces.length > 1 && <button type="button" onClick={onSwitcher} title={keyLabel("Switch workspace (⌃Tab cycles)")} style={{ padding: "6px 10px", border: 0, background: "transparent", color: "var(--mr-well)", cursor: "pointer", font: "inherit" }}>Switch <span className="mr-mono">{keyLabel("⌘J")}</span></button>}
      <button type="button" onClick={onSettings} style={{ padding: "6px 10px", border: 0, background: "transparent", color: "var(--mr-well)", cursor: "pointer", font: "inherit" }}>Settings <span className="mr-mono">{keyLabel("⌘,")}</span></button>
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
    <div role="dialog" className="mr-scrim" aria-label="Switch workspace" data-mr="WorkspaceSwitcher" style={{ position: "fixed", inset: 0, zIndex: 30, display: "flex", justifyContent: "center", alignItems: "flex-start", padding: "96px 24px", background: "rgba(21,24,27,.35)" }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => {
        const k = keyOf(e);
        if (k === "Escape") { e.preventDefault(); onClose(); }
        if (k === "ArrowDown") { e.preventDefault(); setSel((x) => Math.min(list.length - 1, x + 1)); }
        if (k === "ArrowUp") { e.preventDefault(); setSel((x) => Math.max(0, x - 1)); }
        if (k === "Enter" && list[sel]) { e.preventDefault(); go(list[sel].w.id); }
      }}>
      <div className="mr-sheet" style={{ width: "100%", maxWidth: 480, background: "var(--mr-tile)", display: "flex", flexDirection: "column" }}>
        <input autoFocus className="mr-input" placeholder="Switch to…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter workspaces" style={{ margin: 10, fontSize: 16, background: "var(--mr-well)" }} />
        {list.map((x, i) => (
          <button key={x.w.id} type="button" data-mr="WorkspaceOption" data-mr-source={x.w.id} aria-current={i === sel || undefined} onClick={() => go(x.w.id)} onMouseEnter={() => setSel(i)} className="mr-row"
            style={{ gap: 10, padding: "10px 14px", border: 0, font: "inherit", textAlign: "left", cursor: "pointer", color: "var(--mr-ink)", background: i === sel ? "var(--mr-well)" : "transparent", boxShadow: i === sel ? "inset 3px 0 0 var(--mr-selected)" : undefined }}>
            <strong className="mr-grow">{x.w.name}{x.w.id === active ? <span className="mr-dim" style={{ fontWeight: 400 }}> · here</span> : null}</strong>
            {x.n > 0 && <span className="mr-mono" style={{ padding: "0 6px", background: "var(--mr-needs)", fontWeight: 700 }}>{x.n} need you</span>}
            {x.running > 0 && <span className="mr-dim">{x.running} running</span>}
            {x.i < 9 && <kbd className="mr-mono mr-dim">{keyLabel(`⌘${x.i + 1}`)}</kbd>}
          </button>
        ))}
        <div className="mr-row mr-dim" style={{ padding: "8px 14px", background: "var(--mr-band)", fontSize: 12 }}>{keyLabel("↑↓ pick · ↵ switch · ⌃Tab next workspace · ⌘1–9 direct")}</div>
      </div>
    </div>
  );
}

// Deleting a workspace (MR-54): say exactly what goes, stop what's running, confirm by name.
export function DeleteWorkspace({ state, docs, id, onClose, onDeleted }: { state: AppState; docs: Doc[]; id: string; onClose: () => void; onDeleted: () => void }) {
  const ws = state.workspaces.find((w) => w.id === id);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!ws || id === "personal") return null;
  const sessions = Object.values(state.sessions).filter((s) => s.workspace === id);
  const running = sessions.filter((s) => s.status === "working" || s.status === "starting" || s.status === "needs_you" || s.status === "idle").length;
  const docCount = docs.filter((d) => d.session_id && sessions.some((s) => s.id === d.session_id)).length;
  const ok = typed.trim() === ws.name;
  const del = async () => {
    if (!ok || busy) return;
    setBusy(true); setError("");
    try { await invoke("workspace_delete", { id, name: ws.name }); onDeleted(); onClose(); } catch (e) { setError(shortError(e)); setBusy(false); }
  };
  return (
    <div role="dialog" className="mr-scrim" aria-label={`Delete ${ws.name}`} data-mr="DeleteWorkspace" data-mr-source={id} style={{ position: "fixed", inset: 0, zIndex: 30, display: "flex", justifyContent: "center", alignItems: "flex-start", padding: "96px 24px", background: "rgba(21,24,27,.35)" }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} onKeyDown={(e) => { if (keyOf(e) === "Escape") { e.preventDefault(); onClose(); } }}>
      <form onSubmit={(e) => { e.preventDefault(); void del(); }} className="mr-sheet" style={{ width: "100%", maxWidth: 520, background: "var(--mr-tile)", display: "flex", flexDirection: "column", gap: 12, padding: 18, boxShadow: "inset 4px 0 0 var(--mr-error)" }}>
        <strong style={{ fontSize: 18 }}>Delete “{ws.name}”?</strong>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span>{sessions.length ? `${sessions.length} session${sessions.length === 1 ? "" : "s"}` : "No sessions"}{docCount ? ` and ${docCount} working doc${docCount === 1 ? "" : "s"}` : ""} {sessions.length + docCount === 1 ? "moves" : "move"} to Personal's archive as read-only history. They can't be resumed.</span>
          {running > 0 && <span style={{ color: "var(--mr-needs-ink)", fontWeight: 600 }}>{running} still open will be stopped.</span>}
          <span className="mr-dim">Its own Claude sign-in and memory go to the macOS Trash, so you can still get them back from there.</span>
        </div>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span className="mr-dim">Type <b className="mr-mono" style={{ color: "var(--mr-ink)" }}>{ws.name}</b> to confirm</span>
          <input autoFocus className="mr-input" value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Workspace name to confirm" style={{ background: "var(--mr-well)" }} />
        </label>
        {error && <span style={{ color: "var(--mr-error)" }}>{error}</span>}
        <div className="mr-row" style={{ gap: 8 }}>
          <span className="mr-grow" />
          <button type="button" className="mr-key" onClick={onClose}><kbd>esc</kbd>Keep it</button>
          <button type="submit" className="mr-key" disabled={!ok || busy} style={ok ? { background: "var(--mr-error)", color: "var(--mr-tile)" } : undefined}>{busy ? "Deleting…" : "Delete workspace"}</button>
        </div>
      </form>
    </div>
  );
}
