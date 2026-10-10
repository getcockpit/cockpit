import { useEffect, useRef, useState } from "react";
import { Key } from ".";
import { FolderPicker, useWorkFolder } from "./FolderPicker";
import { promptFor } from "../screens/StartPicker";
import { api } from "../state/store";
import type { SessionKind } from "../state/types";

// The empty wall's start (MR-42, F5): nothing is running, so the wall's whole job is to get
// something running. Folder, words, kind, ↵ — the same as ⌘K, without having to know ⌘K.
const KINDS: { id: SessionKind; name: string; what: string }[] = [
  { id: "blank", name: "Do it", what: "Start straight away, in its own worktree" },
  { id: "plan", name: "Plan it first", what: "A working doc you shape before any code" },
];

export function QuickStart({ onStarted, onMore }: { onStarted: (id: string) => void; onMore: () => void }) {
  const [cwd, setCwd] = useWorkFolder();
  const [text, setText] = useState("");
  const [kind, setKind] = useState<SessionKind>("blank");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const start = async () => {
    if (!text.trim() || busy) return;
    setBusy(true); setError("");
    try { onStarted(await api.start(cwd, promptFor(kind, text), kind)); } catch (e) { setError(String(e)); setBusy(false); }
  };
  return (
    <section data-mr="QuickStart" aria-label="Start something" style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 880, margin: "6vh auto 0", width: "100%" }}>
      <h1 style={{ margin: 0, fontSize: 32, lineHeight: 1.15 }}>What do you want to get done?</h1>
      <p className="mr-dim" style={{ margin: 0, fontSize: 15 }}>Say it in your own words. The session shows up here as a tile, and anything it needs from you lands in one queue at the top.</p>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--mr-gap)", background: "var(--mr-tile)", padding: 14 }}>
        <div className="mr-row" style={{ gap: 10, alignItems: "stretch" }}>
          <FolderPicker value={cwd} onChange={(p) => { setCwd(p); input.current?.focus(); }} extra={[]} />
          <span className="mr-dim" style={{ alignSelf: "center" }}>in this folder,</span>
        </div>
        <textarea ref={input} className="mr-input" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Fix the login redirect after OAuth and add a regression test"
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void start(); } }}
          style={{ fontSize: 17, padding: 12, background: "var(--mr-well)", resize: "vertical" }} aria-label="What should Claude do?" />
        <div className="mr-row" style={{ gap: 8, flexWrap: "wrap" }}>
          <div role="radiogroup" aria-label="How" className="mr-row" style={{ gap: 0, background: "var(--mr-well)", padding: 3 }}>
            {KINDS.map((k) => (
              <button key={k.id} type="button" role="radio" aria-checked={kind === k.id} title={k.what} onClick={() => setKind(k.id)}
                style={{ border: 0, padding: "7px 14px", font: "inherit", fontWeight: 600, cursor: "pointer", background: kind === k.id ? "var(--mr-ink)" : "transparent", color: kind === k.id ? "var(--mr-tile)" : "var(--mr-ink)" }}>{k.name}</button>
            ))}
          </div>
          <span className="mr-dim">{KINDS.find((k) => k.id === kind)?.what}</span>
          <span className="mr-grow" />
          <Key k="↵" tone="primary" onClick={() => void start()} disabled={!text.trim() || busy}>{busy ? "Starting…" : "Start"}</Key>
        </div>
        {error && <span style={{ color: "var(--mr-error)" }}>{error}</span>}
      </div>
      <div className="mr-row mr-dim" style={{ gap: 14 }}>
        <span>Or:</span>
        <button type="button" className="mr-key" onClick={onMore}>Review a PR</button>
        <button type="button" className="mr-key" onClick={onMore}>Address PR comments</button>
        <span className="mr-grow" />
        <span><span className="mr-mono">⌘K</span> starts anything, from anywhere</span>
      </div>
    </section>
  );
}
