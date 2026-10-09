import { useEffect, useMemo, useRef, useState } from "react";
import { Bar, Key, StateMark } from "../components";
import { pickTile } from "../picker/pick";
import { api } from "../state/store";
import type { SessionState, TranscriptItem } from "../state/types";
import type { Doc } from "../state/docs";
import { AskRow } from "./AskRow";
import { AddressView, ReviewView } from "./Flows";

// Focus view: one session, zoomed in. Decisions first, then plan + changes, then the transcript.
export function Focus({ s, docs, onOpenDoc, onBack }: { s: SessionState; docs: Doc[]; onOpenDoc: (id: string) => void; onBack: () => void }) {
  const tile = useMemo(() => pickTile(s), [s]);
  const [showRaw, setShowRaw] = useState(false);
  const [text, setText] = useState("");
  const live = s.status !== "ended" && s.status !== "error";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (e.key === "Escape" && !typing) { e.preventDefault(); onBack(); }
      if (e.key === "." && e.metaKey && live) { e.preventDefault(); void api.interrupt(s.id); }
      if (e.key === "r" && e.metaKey) { e.preventDefault(); setShowRaw((x) => !x); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack, s.id, live]);

  const files = Object.values(s.files).sort((a, b) => b.added + b.removed - (a.added + a.removed));
  const maxChange = Math.max(1, ...files.map((f) => f.added + f.removed));

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100%" }}>
      <header className="mr-band mr-row" style={{ padding: "14px 24px" }}>
        <button type="button" onClick={onBack} className="mr-key" style={{ minHeight: 30 }}><kbd>esc</kbd>Wall</button>
        <strong className="mr-ellipsis" style={{ fontSize: 15, maxWidth: 520 }}>{s.title || "Untitled"}</strong>
        <span className="mr-mono mr-dim mr-ellipsis">{s.cwd}</span>
        <span className="mr-grow" />
        <StateMark s={tile.state} />
        <span className="mr-mono mr-ink2">{tile.progressLabel || tile.step}</span>
        <Key k="⌘R" onClick={() => setShowRaw((x) => !x)}>{showRaw ? "Visual" : "Transcript"}</Key>
      </header>

      <main style={{ flex: 1, display: "flex", flexWrap: "wrap", gap: 16, padding: "16px 24px" }}>
        <section style={{ flex: "999 1 560px", minWidth: 0, display: "flex", flexDirection: "column", gap: 12 }}>
          {docs.map((d) => (
            <button key={d.id} type="button" className="mr-qrow" onClick={() => onOpenDoc(d.id)} style={{ border: 0, padding: 0, font: "inherit", color: "inherit", textAlign: "left", cursor: "pointer" }}>
              <div className="mr-flag" style={{ background: "var(--mr-selected)" }} />
              <div className="mr-qbody" style={{ flexDirection: "row", alignItems: "center" }}>
                <div className="mr-grow" style={{ display: "flex", flexDirection: "column" }}><span className="mr-dim">Working doc · v{d.version} · {Object.keys(d.blocks).length} blocks</span><strong style={{ fontSize: 17 }}>{d.title}</strong></div>
                <span className="mr-key">Open map ↵</span>
              </div>
            </button>
          ))}
          {s.pending.length > 0 && <div className="mr-queue">{s.pending.map((a) => <AskRow key={a.requestId} s={s} a={a} />)}</div>}
          {s.error && <div className="mr-qrow"><div className="mr-flag" style={{ background: "var(--mr-error)" }} /><div className="mr-qbody"><strong style={{ color: "var(--mr-error)" }}>✕ Session failed</strong><span>{s.error}</span></div></div>}
          {!showRaw && s.review ? <ReviewView s={s} /> : !showRaw && s.address ? <AddressView s={s} /> : <Transcript items={s.transcript} raw={showRaw} />}
          {live && (
            <form className="mr-row" onSubmit={(e) => { e.preventDefault(); if (text.trim()) { void api.send(s.id, text.trim()); setText(""); } }}>
              <span className="mr-mono" style={{ padding: "2px 6px", background: "var(--mr-ink)", color: "var(--mr-tile)" }}>→</span>
              <input className="mr-input" placeholder="Steer this session — or ⌘. to interrupt" value={text} onChange={(e) => setText(e.target.value)} aria-label="Message this session" />
              <Key k="⌘." onClick={() => void api.interrupt(s.id)}>Interrupt</Key>
            </form>
          )}
        </section>

        <aside style={{ flex: "1 1 300px", minWidth: 0, display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ background: "var(--mr-tile)", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
            <h2 className="mr-h">Plan</h2>
            {s.todos.length === 0 ? <span className="mr-dim">No plan yet.</span> : s.todos.map((t, i) => (
              <div key={i} className="mr-row" style={{ color: t.status === "in_progress" ? "var(--mr-ink)" : t.status === "completed" ? "var(--mr-ink-3)" : "var(--mr-ink-2)", fontWeight: t.status === "in_progress" ? 700 : 400 }}>
                <span aria-hidden="true" style={{ width: 14 }}>{t.status === "completed" ? "✓" : t.status === "in_progress" ? "▸" : "·"}</span>
                <span>{t.status === "in_progress" && t.activeForm ? t.activeForm : t.content}</span>
              </div>
            ))}
            {s.todos.length > 0 && <Bar value={tile.progress} />}
          </div>
          <div style={{ background: "var(--mr-tile)", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
            <h2 className="mr-h">Changes <span className="mr-dim mr-mono">+{files.reduce((a, f) => a + f.added, 0)} −{files.reduce((a, f) => a + f.removed, 0)}</span></h2>
            {files.length === 0 ? <span className="mr-dim">No files changed.</span> : files.map((f) => (
              <div key={f.path} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <div className="mr-row" style={{ alignItems: "baseline" }}>
                  <span className="mr-mono mr-grow mr-ellipsis" style={{ fontSize: 12 }} title={f.path}>{f.isNew ? "+ " : "~ "}{f.path.replace(s.cwd + "/", "")}</span>
                  <span className="mr-mono mr-dim" style={{ fontSize: 12 }}>+{f.added}{f.removed ? ` −${f.removed}` : ""}</span>
                </div>
                <div className="mr-bar" style={{ height: 3 }}><i style={{ height: 3, width: `${Math.max(4, ((f.added + f.removed) / maxChange) * 100)}%` }} /></div>
              </div>
            ))}
          </div>
          <span className="mr-mono mr-dim" style={{ fontSize: 12 }}>{s.model ?? ""}{s.costUsd ? ` · $${s.costUsd.toFixed(2)} equiv.` : ""}</span>
        </aside>
      </main>
    </div>
  );
}

// The structured transcript (decision 13): readable rows, not terminal text. ⌘R shows raw JSON.
function Transcript({ items, raw }: { items: TranscriptItem[]; raw: boolean }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "nearest" }); }, [items.length]);
  if (items.length === 0) return <div className="mr-dim" style={{ padding: 12, background: "var(--mr-tile)" }}>Waiting for the first message…</div>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--mr-gap)" }}>
      {items.map((t) => raw ? (
        <pre key={t.id} className="mr-code" style={{ fontSize: 11 }}>{JSON.stringify(t, null, 1)}</pre>
      ) : t.kind === "text" ? (
        <div key={t.id} style={{ padding: "12px 14px", background: "var(--mr-tile)", whiteSpace: "pre-wrap" }}>{t.text}</div>
      ) : t.kind === "user" ? (
        <div key={t.id} className="mr-row" style={{ padding: "10px 14px", background: "var(--mr-well)" }}><span className="mr-mono mr-dim">you →</span><span>{t.text}</span></div>
      ) : t.kind === "result" ? (
        <div key={t.id} className="mr-row mr-mono" style={{ padding: "6px 14px", color: t.ok ? "var(--mr-done)" : "var(--mr-error)", fontSize: 12 }}>{t.ok ? "✓ turn finished" : "✕ turn failed"}</div>
      ) : (
        <ToolRow key={t.id} t={t} />
      ))}
      <div ref={end} />
    </div>
  );
}

function ToolRow({ t }: { t: Extract<TranscriptItem, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const detail = t.input.command ?? t.input.file_path ?? t.input.pattern ?? t.input.url ?? t.input.query ?? t.input.description ?? "";
  const result = t.result as Record<string, unknown> | string | undefined;
  const out = typeof result === "string" ? result : result ? String(result.stdout ?? result.content ?? JSON.stringify(result)) : "";
  return (
    <div style={{ background: "var(--mr-tile)" }}>
      <button type="button" onClick={() => setOpen((x) => !x)} className="mr-row" style={{ width: "100%", padding: "8px 14px", border: 0, background: "transparent", color: "inherit", font: "inherit", textAlign: "left", cursor: "pointer" }}>
        <span className="mr-mono" style={{ fontWeight: 700, minWidth: 90 }}>{t.name.replace(/^mcp__/, "")}</span>
        <span className="mr-mono mr-ink2 mr-grow mr-ellipsis" style={{ fontSize: 12 }}>{String(detail)}</span>
        <span className="mr-mono" style={{ fontSize: 12, color: t.isError ? "var(--mr-error)" : t.result === undefined ? "var(--mr-ink-3)" : "var(--mr-done)" }}>{t.isError ? "✕" : t.result === undefined ? "…" : "✓"}</span>
      </button>
      {open && out && <pre className="mr-code" style={{ margin: "0 14px 10px", maxHeight: 260, overflow: "auto", fontSize: 12 }}>{out.slice(0, 4000)}</pre>}
    </div>
  );
}
