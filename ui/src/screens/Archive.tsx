import { useEffect, useMemo, useState } from "react";
import { Key, StateMark } from "../components";
import { keyOf } from "../components/keys";
import { pickTile } from "../picker/pick";
import { api } from "../state/store";
import type { SessionState } from "../state/types";

// The archive (MR-39): sessions you marked done. They leave the wall but keep their whole
// history; open one to read it, restore it to the wall, or resume the conversation.

export function Archive({ sessions, onOpen, onClose }: { sessions: SessionState[]; onOpen: (id: string) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return [...sessions].sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0))
      .filter((s) => !needle || `${s.title} ${s.repo ?? ""} ${s.branch ?? ""} ${s.cwd}`.toLowerCase().includes(needle));
  }, [sessions, q]);
  useEffect(() => setSel(0), [q]);
  const day = (t: number | null) => (t ? new Date(t).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) : "");

  const onKey = (e: React.KeyboardEvent) => {
    const k = keyOf(e);
    if (k === "Escape") { e.preventDefault(); onClose(); }
    if (k === "ArrowDown") { e.preventDefault(); setSel((x) => Math.min(list.length - 1, x + 1)); }
    if (k === "ArrowUp") { e.preventDefault(); setSel((x) => Math.max(0, x - 1)); }
    if (k === "Enter" && list[sel]) { e.preventDefault(); onOpen(list[sel].id); }
  };

  let lastDay = "";
  return (
    <div role="dialog" aria-label="Archive" data-mr="Archive" onKeyDown={onKey}
      style={{ position: "fixed", inset: 0, zIndex: 20, display: "flex", justifyContent: "center", alignItems: "flex-start", padding: "56px 24px", background: "rgba(21,24,27,.35)", overflowY: "auto" }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ width: "100%", maxWidth: 920, background: "var(--mr-tile)", display: "flex", flexDirection: "column" }}>
        <div className="mr-band mr-row" style={{ padding: "12px 16px" }}>
          <strong>Archive</strong><span className="mr-dim">{sessions.length} done</span>
          <span className="mr-grow" />
          <Key k="esc" onClick={onClose}>Close</Key>
        </div>
        <input autoFocus className="mr-input" placeholder="Search titles, repos, branches" value={q} onChange={(e) => setQ(e.target.value)} style={{ margin: 12, background: "var(--mr-well)" }} aria-label="Search the archive" />
        {list.length === 0 && <div className="mr-dim" style={{ padding: "8px 16px 20px" }}>{sessions.length ? "Nothing matches." : "Nothing archived yet. Mark a session done (in its focus view, the review tray, or by right-clicking it) and it lands here."}</div>}
        <div style={{ display: "flex", flexDirection: "column", padding: "0 12px 12px" }}>
          {list.map((s, i) => {
            const d = day(s.archivedAt);
            const head = d !== lastDay ? (lastDay = d) : null;
            return (
              <div key={s.id}>
                {head && <div className="mr-h" style={{ padding: "12px 4px 6px" }}>{head}</div>}
                <div data-mr="ArchivedSession" data-mr-source={s.id} className="mr-row" onMouseEnter={() => setSel(i)} onClick={() => onOpen(s.id)}
                  style={{ padding: "10px 12px", gap: 12, cursor: "pointer", background: i === sel ? "var(--mr-well)" : "transparent", boxShadow: i === sel ? "inset 3px 0 0 var(--mr-selected)" : undefined }}>
                  <StateMark s={pickTile(s).state === "error" ? "error" : "done"} />
                  <span style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
                    <strong className="mr-ellipsis">{s.title || "Untitled"}</strong>
                    <span className="mr-mono mr-dim mr-ellipsis" style={{ fontSize: 12 }}>{s.kind !== "blank" ? `${s.kind} · ` : ""}{s.branch ?? s.repo ?? s.cwd}</span>
                  </span>
                  <span className="mr-mono mr-dim" style={{ fontSize: 12 }}>{Object.keys(s.files).length} files{s.costUsd ? ` · $${s.costUsd.toFixed(2)}` : ""}</span>
                  <span onClick={(e) => e.stopPropagation()} className="mr-row" style={{ gap: 6 }}>
                    <Key onClick={() => void api.log("ui.session_unarchived", {}, s.id)}>Restore</Key>
                    {s.sdkSessionId && <Key onClick={() => { void api.log("ui.session_unarchived", {}, s.id); void api.resume(s); onOpen(s.id); }}>Resume ↻</Key>}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
