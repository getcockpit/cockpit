import { useEffect, useRef, useState } from "react";
import { keyOf } from "./keys";
import { api } from "../state/store";
import type { AppState, SessionState } from "../state/types";

// Moves a session to another workspace (MR-154). Its conversation is copied into that workspace's
// Claude folder, so it resumes there with that workspace's sign-in and memory. A session waiting
// for you is stopped first; one mid-turn is queued and moves once its turn ends (MR-177).
export function MoveWorkspace({ s, workspaces, running }: { s: SessionState; workspaces: AppState["workspaces"]; running: boolean }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const here = workspaces.find((w) => w.id === s.workspace)?.name ?? "Personal";
  const others = workspaces.filter((w) => w.id !== s.workspace);
  const queued = running ? s.moveTo : null; // a stale one (the app restarted mid-turn) doesn't count
  const pending = queued ? workspaces.find((w) => w.id === s.moveTo)?.name ?? "another workspace" : null;

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
      .then((r) => { setOpen(false); toast(r === "queued" ? `Moves to ${w.name} when this turn ends` : `Moved to ${w.name}`); })
      .catch((e) => toast(`Not moved: ${String(e).split("\n")[0]}`))
      .finally(() => setBusy(false));
  };
  const cancel = () => {
    void api.moveCancel(s.id).then(() => { setOpen(false); toast("Stays here"); }).catch((e) => toast(String(e).split("\n")[0]));
  };

  return (
    <div ref={box} style={{ position: "relative" }} data-mr="MoveWorkspace" data-mr-source={s.id}>
      <button type="button" className="mr-key" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((x) => !x)} title="Move this session to another workspace">
        <span>{pending ? `${here} → ${pending} after this turn` : here}</span>
        <span className="mr-dim" aria-hidden>▾</span>
      </button>
      {s.moveFailed && !pending && <span data-mr="MoveFailed" data-mr-source={s.id} style={{ color: "var(--mr-error)", marginLeft: 8 }}>Not moved: {s.moveFailed}</span>}
      {open && (
        <div role="menu" aria-label="Move to workspace" className="mr-pop"
          style={{ position: "absolute", top: "calc(100% + 4px)", right: 0, width: 280, zIndex: 20, background: "var(--mr-tile)", boxShadow: "0 0 0 1px var(--mr-ink-3), 0 8px 24px rgba(21,24,27,.2)", display: "flex", flexDirection: "column", padding: "8px 0" }}>
          <span className="mr-dim" style={{ padding: "0 12px 6px", fontSize: 12 }}>
            {pending
              ? `Moves to ${pending} when this turn ends.`
              : running
                ? "It's working: it moves when this turn ends. The conversation goes with it and continues under that workspace's sign-in."
                : "Move to another workspace. The conversation goes with it and continues under that workspace's sign-in."}
          </span>
          {pending && (
            <button type="button" role="menuitem" onClick={cancel} data-mr="MoveWorkspaceCancel" data-mr-source={s.id}
              style={{ border: 0, padding: "7px 12px", font: "inherit", textAlign: "left", cursor: "pointer", color: "var(--mr-ink)", background: "transparent" }}>
              Cancel the move: stay in {here}
            </button>
          )}
          {others.map((w) => (
            <button key={w.id} type="button" role="menuitem" disabled={busy || w.id === queued} onClick={() => move(w)} data-mr="MoveWorkspaceRow" data-mr-source={w.id}
              style={{ border: 0, padding: "7px 12px", font: "inherit", textAlign: "left", cursor: busy || w.id === queued ? "default" : "pointer", color: w.id === queued ? "var(--mr-ink-3)" : "var(--mr-ink)", background: "transparent" }}>
              {w.name}{w.id === queued ? " · after this turn" : ""}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
