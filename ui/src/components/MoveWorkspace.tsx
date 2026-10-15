import { useEffect, useRef, useState } from "react";
import { keyOf } from "./keys";
import { api } from "../state/store";
import type { AppState, SessionState } from "../state/types";

// Moves a session to another workspace (MR-154). Its conversation is copied into that workspace's
// Claude folder, so it resumes there with that workspace's sign-in and memory. A session waiting
// for you is stopped first; one mid-turn has to finish (or be interrupted) before it can move.
export function MoveWorkspace({ s, workspaces, running }: { s: SessionState; workspaces: AppState["workspaces"]; running: boolean }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const here = workspaces.find((w) => w.id === s.workspace)?.name ?? "Personal";
  const others = workspaces.filter((w) => w.id !== s.workspace);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (keyOf(e) === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); } };
    document.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc, true);
    return () => { document.removeEventListener("mousedown", away); window.removeEventListener("keydown", esc, true); };
  }, [open]);

  if (!others.length) return null;
  const toast = (detail: string) => window.dispatchEvent(new CustomEvent("mr:toast", { detail }));
  const move = (w: { id: string; name: string }) => {
    setBusy(true);
    void api.move(s.id, w.id)
      .then(() => { setOpen(false); toast(`Moved to ${w.name}`); })
      .catch((e) => toast(`Not moved: ${String(e).split("\n")[0]}`))
      .finally(() => setBusy(false));
  };

  return (
    <div ref={box} style={{ position: "relative" }} data-mr="MoveWorkspace" data-mr-source={s.id}>
      <button type="button" className="mr-key" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((x) => !x)} title="Move this session to another workspace">
        <span>{here}</span>
        <span className="mr-dim" aria-hidden>▾</span>
      </button>
      {open && (
        <div role="menu" aria-label="Move to workspace" className="mr-pop"
          style={{ position: "absolute", top: "calc(100% + 4px)", right: 0, width: 280, zIndex: 20, background: "var(--mr-tile)", boxShadow: "0 0 0 1px var(--mr-ink-3), 0 8px 24px rgba(21,24,27,.2)", display: "flex", flexDirection: "column", padding: "8px 0" }}>
          <span className="mr-dim" style={{ padding: "0 12px 6px", fontSize: 12 }}>
            {running ? "It's working: interrupt it or wait for its turn to end, then move it." : "Move to another workspace. The conversation goes with it and continues under that workspace's sign-in."}
          </span>
          {others.map((w) => (
            <button key={w.id} type="button" role="menuitem" disabled={running || busy} onClick={() => move(w)} data-mr="MoveWorkspaceRow" data-mr-source={w.id}
              style={{ border: 0, padding: "7px 12px", font: "inherit", textAlign: "left", cursor: running || busy ? "default" : "pointer", color: running ? "var(--mr-ink-3)" : "var(--mr-ink)", background: "transparent" }}>
              {w.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
