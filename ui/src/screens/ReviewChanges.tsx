import { useEffect, useState } from "react";
import { Key } from "../components";
import { keyOf } from "../components/keys";
import { modKey } from "../platform";
import { plural } from "../picker/title";
import { api } from "../state/store";
import type { SessionState } from "../state/types";
import { DiffView, useChanges } from "./ChangeMap";
import { basename } from "../fspath";

// Reviewing the code a session wrote (MR-49, J11), in the main column: files on the left, the diff
// on the right, notes on any line. Then either send the notes back, or call it good and ship.
type Note = { path: string; line: string; text: string };

export function ReviewChanges({ s, start, onClose }: { s: SessionState; start: string; onClose: () => void }) {
  const { files } = useChanges(s);
  const [path, setPath] = useState(start);
  const [notes, setNotes] = useState<Note[]>([]);
  const [sent, setSent] = useState("");
  const list = files ?? [];
  const idx = Math.max(0, list.findIndex((f) => f.path === path));

  const sendNotes = () => {
    void api.send(s.id, `Review notes on your changes (fix each, then say what you did):\n${notes.map((n) => `- ${n.path}${n.line ? `:${n.line}` : ""}: ${n.text}`).join("\n")}`);
    void api.log("ui.diff_notes_sent", { count: notes.length }, s.id);
    setNotes([]); setSent("Sent. The session is working on your notes.");
  };
  const approve = () => {
    void api.send(s.id, "I reviewed the changes and they look good. Commit them with a clear message, push the branch and open a PR. Reply with the PR link.");
    void api.log("ui.changes_approved", { files: list.length }, s.id);
    setSent("Approved. The session is committing and opening a PR.");
  };

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.("input, textarea")) return;
      const key = keyOf(e);
      if (key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
      if (key === "j" && list[idx + 1]) { e.preventDefault(); setPath(list[idx + 1].path); }
      if (key === "k" && list[idx - 1]) { e.preventDefault(); setPath(list[idx - 1].path); }
      if (key === "Enter" && modKey(e)) { e.preventDefault(); if (notes.length) sendNotes(); else approve(); }
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  });

  return (
    <section data-mr="ReviewChanges" data-mr-source={s.id} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="mr-row" style={{ gap: 10, padding: "10px 14px", background: "var(--mr-tile)" }}>
        <Key k="esc" onClick={onClose}>Back</Key>
        <strong>Reviewing {plural(list.length, "file")}</strong>
        <span className="mr-dim">J/K next file · click a line to note it</span>
        <span className="mr-grow" />
        {notes.length > 0
          ? <Key k="⌘↵" tone="primary" onClick={sendNotes}>Send {plural(notes.length, "note")}</Key>
          : <Key k="⌘↵" tone="primary" onClick={approve}>Looks good · open a PR</Key>}
      </div>
      {sent && <span style={{ color: "var(--mr-done)" }}>{sent}</span>}
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
        <nav aria-label="Changed files" style={{ flex: "0 0 220px", display: "flex", flexDirection: "column", gap: "var(--mr-gap)" }}>
          {list.map((f) => {
            const n = notes.filter((x) => x.path === f.path).length;
            return (
              <button key={f.path} type="button" onClick={() => setPath(f.path)} title={f.path}
                style={{ display: "flex", flexDirection: "column", gap: 2, padding: "7px 10px", border: 0, borderLeft: `4px solid ${f.risky ? "var(--mr-needs)" : "transparent"}`, background: f.path === path ? "var(--mr-ink)" : "var(--mr-tile)", color: f.path === path ? "var(--mr-tile)" : "var(--mr-ink)", font: "inherit", textAlign: "left", cursor: "pointer" }}>
                <span className="mr-mono mr-ellipsis" style={{ fontSize: 12 }}>{basename(f.path)}</span>
                <span className="mr-mono" style={{ fontSize: 11, opacity: 0.75 }}>+{f.added} −{f.removed}{f.risky ? ` · ${f.risky}` : ""}{n ? ` · ${plural(n, "note")}` : ""}</span>
              </button>
            );
          })}
        </nav>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
          <span className="mr-mono mr-dim" style={{ fontSize: 12 }}>{path}</span>
          <DiffView key={path} cwd={s.cwd} path={path} notes={notes.filter((n) => n.path === path)}
            onNote={(line, text) => { setNotes((x) => [...x, { path, line, text }]); setSent(""); void api.log("ui.diff_note", { path, line, text }, s.id, `diff:${path}:${line}`); }} />
        </div>
      </div>
    </section>
  );
}
