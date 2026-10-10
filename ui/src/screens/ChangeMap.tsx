import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Key } from "../components";
import { pointer } from "../components/pointer";
import { api } from "../state/store";
import type { SessionState } from "../state/types";

// Change map (MR-17): what the session changed, from git, grouped by folder and sized by change,
// with risky areas flagged. Click a file for its diff; click a diff line to leave a note.
export type Changed = { path: string; added: number; removed: number; status: string; risky: string | null };

// git's errors are long (a "not a git repository" comes with the whole `git diff` usage text):
// show a short line, never the raw dump.
export function changesError(error: string): string {
  if (/not a git repository/i.test(error)) return "not a git repository";
  const first = error.split("\n").find((l) => l.trim()) ?? error;
  return first.trim().slice(0, 160);
}

/** The session's changed files from git, refreshed while it works. */
export function useChanges(s: SessionState): { files: Changed[] | null; error: string } {
  const [files, setFiles] = useState<Changed[] | null>(null);
  const [error, setError] = useState("");
  const touched = Object.keys(s.files).length;
  useEffect(() => {
    let alive = true;
    const load = () => invoke<Changed[]>("session_changes", { cwd: s.cwd }).then((f) => alive && (setFiles(f), setError(""))).catch((e) => alive && setError(String(e)));
    load();
    const t = setInterval(load, s.status === "working" ? 5000 : 30000);
    return () => { alive = false; clearInterval(t); };
  }, [s.cwd, s.status, touched]);
  return { files, error };
}

// The change map (side panel): where the session's changes are. Click a file to review it in the
// main column (MR-49), ⌥-click to ask a side session about it.
export function ChangeMap({ s, onReview }: { s: SessionState; onReview: (path: string) => void }) {
  const { files, error } = useChanges(s);

  const groups = useMemo(() => {
    const g = new Map<string, Changed[]>();
    for (const f of files ?? []) {
      const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ".";
      g.set(dir, [...(g.get(dir) ?? []), f]);
    }
    return [...g.entries()].sort((a, b) => sum(b[1]) - sum(a[1]));
  }, [files]);
  const max = Math.max(1, ...(files ?? []).map((f) => f.added + f.removed));
  const discover = (f: Changed) => void api.start(s.cwd, `Side thread about the change to ${f.path} in session "${s.title}". Explain briefly what it changes, what else depends on it, and any risk. Don't change anything.`, "blank", false);

  // Not a repo: there is nothing to map, so show nothing rather than an error (god-mode mark).
  if (error && changesError(error) === "not a git repository") return null;
  if (error) return <div data-mr="ChangeMap" data-mr-source={s.id} style={{ background: "var(--mr-tile)", padding: "14px 16px" }} className="mr-dim">Changes: {changesError(error)}</div>;
  return (
    <div data-mr="ChangeMap" data-mr-source={s.id} style={{ background: "var(--mr-tile)", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
      <h2 className="mr-h">Changes <span className="mr-dim mr-mono">+{(files ?? []).reduce((a, f) => a + f.added, 0)} −{(files ?? []).reduce((a, f) => a + f.removed, 0)}</span><span className="mr-grow" />{(files ?? []).length > 0 && <Key onClick={() => onReview(files![0].path)}>Review</Key>}</h2>
      {files === null ? <span className="mr-dim">Reading git…</span> : files.length === 0 ? <span className="mr-dim">No changes on disk.</span> : groups.map(([dir, fs]) => (
        <div key={dir} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span className="mr-mono mr-dim" style={{ fontSize: 11 }}>{dir}/</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--mr-gap)" }}>
            {fs.map((f) => (
              <button key={f.path} type="button" data-mr="ChangeNode" data-mr-source={f.path}
                onClick={pointer({ open: () => onReview(f.path), deeper: () => onReview(f.path), discover: () => discover(f) })}
                title={`${f.path} · +${f.added} −${f.removed}${f.risky ? ` · ${f.risky}` : ""}`}
                style={{ flex: `${Math.max(1, Math.round(((f.added + f.removed) / max) * 6))} 1 90px`, minWidth: 90, padding: "6px 8px", border: 0, borderLeft: `4px solid ${f.risky ? "var(--mr-needs)" : f.status === "untracked" ? "var(--mr-done)" : "var(--mr-ink-3)"}`, background: "var(--mr-well)", color: "var(--mr-ink)", font: "inherit", textAlign: "left", cursor: "pointer" }}>
                <span className="mr-mono mr-ellipsis" style={{ display: "block", fontSize: 12 }}>{f.status === "untracked" ? "+ " : f.status === "deleted" ? "− " : ""}{f.path.split("/").pop()}</span>
                <span className="mr-mono" style={{ fontSize: 11, opacity: 0.75 }}>+{f.added} −{f.removed}{f.risky ? ` · ${f.risky}` : ""}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

const sum = (fs: Changed[]) => fs.reduce((a, f) => a + f.added + f.removed, 0);

export function DiffView({ cwd, path, notes, onNote }: { cwd: string; path: string; notes: { line: string; text: string }[]; onNote: (line: string, text: string) => void }) {
  const [diff, setDiff] = useState<string | null>(null);
  const [at, setAt] = useState<string | null>(null);
  const [text, setText] = useState("");
  useEffect(() => { invoke<string>("session_diff", { cwd, path }).then(setDiff).catch((e) => setDiff(`# ${e}`)); }, [cwd, path]);
  if (diff === null) return <span className="mr-dim">Loading diff…</span>;
  let newLine = 0;
  const rows = diff.split("\n").map((l, i) => {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
    if (hunk) newLine = Number(hunk[1]) - 1;
    else if (!l.startsWith("-") && !l.startsWith("diff ") && !l.startsWith("index ") && !l.startsWith("+++") && !l.startsWith("---")) newLine++;
    const ln = l.startsWith("+") && !l.startsWith("+++") ? String(newLine) : l.startsWith(" ") ? String(newLine) : "";
    return { i, l, ln };
  }).filter((r) => !/^(diff |index |--- |\+\+\+ )/.test(r.l));
  return (
    <div className="mr-mono" data-mr="DiffView" data-mr-source={path} style={{ fontSize: 12, background: "var(--mr-well)", overflow: "auto" }}>
      {rows.map(({ i, l, ln }) => (
        <div key={i}>
          <div onClick={() => ln && setAt(at === ln ? null : ln)} style={{ display: "flex", gap: 10, padding: "1px 10px", whiteSpace: "pre", cursor: ln ? "text" : "default", background: l.startsWith("+") ? "rgba(30,122,76,.14)" : l.startsWith("-") ? "rgba(198,40,40,.12)" : l.startsWith("@@") ? "var(--mr-band)" : "transparent" }}>
            <span style={{ width: 34, textAlign: "right", color: "var(--mr-ink-3)" }}>{ln}</span><span>{l || " "}</span>
          </div>
          {notes.filter((n) => n.line === ln && ln).map((n, j) => <div key={j} style={{ margin: "2px 10px 2px 54px", padding: "4px 8px", background: "var(--mr-tile)", borderLeft: "3px solid var(--mr-selected)", fontFamily: "var(--mr-font)" }}>{n.text}</div>)}
          {at === ln && ln && (
            <form onSubmit={(e) => { e.preventDefault(); if (text.trim()) { onNote(ln, text.trim()); setText(""); setAt(null); } }} style={{ margin: "2px 10px 4px 54px" }}>
              <input autoFocus className="mr-input" style={{ minHeight: 30, fontSize: 13, fontFamily: "var(--mr-font)" }} placeholder={`Note on line ${ln} (sent with "Send notes")`} value={text} onChange={(e) => setText(e.target.value)} />
            </form>
          )}
        </div>
      ))}
    </div>
  );
}
