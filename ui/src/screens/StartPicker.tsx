import { useEffect, useMemo, useRef, useState } from "react";
import { Key } from "../components";
import { api, type Pr } from "../state/store";
import type { AppState, SessionKind } from "../state/types";

// ⌘K start picker (decision 18): Review / Address / Plan / Blank, each with its own suggestions.
const MODES: { id: SessionKind; name: string; what: string; placeholder: string }[] = [
  { id: "review", name: "Review", what: "Walk a PR snippet by snippet", placeholder: "PR number or URL, e.g. 4412" },
  { id: "address", name: "Address", what: "Work through review comments", placeholder: "Your PR number" },
  { id: "plan", name: "Plan", what: "Shape an idea into a spec", placeholder: "Describe what you want to build…" },
  { id: "blank", name: "Blank", what: "Just start a session", placeholder: "What should Claude do?" },
];

// What each mode actually sends to Claude Code. Review/Address use the user's own commands.
export function promptFor(mode: SessionKind, text: string): string {
  const t = text.trim();
  if (mode === "review") return `/review ${t}`;
  if (mode === "address") return `/pr-address ${t}`;
  if (mode === "plan") return `Plan this with me before any code: ${t}. Write the plan as a working document using the mr doc tools.`;
  return t;
}

type Item = { ref: string; title: string; meta: string; hot: boolean; value: string };

export function StartPicker({ state, onClose, onStarted, initialText = "" }: { state: AppState; onClose: () => void; onStarted: (id: string) => void; initialText?: string }) {
  const [mode, setMode] = useState<SessionKind>(initialText ? "blank" : "review");
  const [text, setText] = useState(initialText);
  const [cwd, setCwd] = useState(() => { try { return localStorage.getItem("mr.cwd") ?? "~/"; } catch { return "~/"; } });
  const [prs, setPrs] = useState<Pr[] | null>(null);
  const [error, setError] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { input.current?.focus(); }, [mode]);
  useEffect(() => { try { localStorage.setItem("mr.cwd", cwd); } catch { /* convenience only */ } }, [cwd]);
  useEffect(() => {
    setPrs(null); setSel(0);
    if (mode !== "review" && mode !== "address") return;
    let alive = true;
    api.prs(cwd, mode).then((r) => alive && setPrs(r)).catch((e) => alive && (setPrs([]), setError(String(e))));
    return () => { alive = false; };
  }, [mode, cwd]);

  const items: Item[] = useMemo(() => {
    if (mode === "review" || mode === "address") {
      return (prs ?? []).map((p) => ({
        ref: `#${p.number}`, value: p.url, title: `${p.title}${p.author ? ` · @${p.author.login}` : ""}`,
        meta: mode === "address" ? (p.reviewDecision === "CHANGES_REQUESTED" ? "Changes requested" : p.reviewDecision ? p.reviewDecision.toLowerCase().replace("_", " ") : "open") : (p.repository?.nameWithOwner ?? ""),
        hot: mode === "address" ? p.reviewDecision === "CHANGES_REQUESTED" : true,
      }));
    }
    const recent = state.order.map((id) => state.sessions[id]).filter((s) => s.kind === mode).reverse().slice(0, 5);
    return recent.map((s) => ({ ref: "", value: s.title.replace(/^Plan this with me before any code: /, "").replace(/\. Write the plan.*$/, ""), title: s.title, meta: new Date(s.startedAt).toLocaleDateString(), hot: false }));
  }, [mode, prs, state]);

  const start = async (value: string) => {
    if (!value.trim()) return;
    setError("");
    try {
      const id = await api.start(cwd, promptFor(mode, value), mode);
      onStarted(id);
    } catch (e) { setError(String(e)); }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
    else if (e.metaKey && ["1", "2", "3", "4"].includes(e.key)) { e.preventDefault(); setMode(MODES[Number(e.key) - 1].id); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setSel((x) => Math.min(items.length - 1, x + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((x) => Math.max(0, x - 1)); }
    else if (e.key === "Enter" && !text.trim() && items[sel]) { e.preventDefault(); void start(items[sel].value); }
  };

  const m = MODES.find((x) => x.id === mode)!;
  return (
    <div role="dialog" aria-label="Start something" onKeyDown={onKey}
      style={{ position: "fixed", inset: 0, display: "flex", justifyContent: "center", alignItems: "flex-start", padding: "96px 24px", background: "rgba(21,24,27,.35)", zIndex: 10 }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ width: "100%", maxWidth: 880, background: "var(--mr-tile)", display: "flex", flexDirection: "column" }}>
        <form className="mr-row" style={{ padding: "14px 18px", background: "var(--mr-band)" }} onSubmit={(e) => { e.preventDefault(); void start(text); }}>
          <input className="mr-input mr-mono" style={{ flex: "0 1 220px", fontSize: 13, background: "var(--mr-well)" }} value={cwd} onChange={(e) => setCwd(e.target.value)} aria-label="Project folder" />
          <input ref={input} className="mr-input" style={{ fontSize: 17, background: "var(--mr-well)" }} placeholder={m.placeholder} value={text} onChange={(e) => setText(e.target.value)} aria-label={m.placeholder} />
          <Key k="↵" tone="primary" disabled={!text.trim() && !items[sel]}>Start</Key>
        </form>
        <div role="radiogroup" aria-label="Kind of session" style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: "var(--mr-gap)", padding: "12px 18px" }}>
          {MODES.map((x, i) => (
            <button key={x.id} type="button" role="radio" aria-checked={x.id === mode} onClick={() => setMode(x.id)}
              style={{ display: "flex", flexDirection: "column", gap: 4, padding: 12, border: 0, borderRadius: "var(--mr-radius)", textAlign: "left", cursor: "pointer", background: x.id === mode ? "var(--mr-ink)" : "var(--mr-well)", color: x.id === mode ? "var(--mr-tile)" : "var(--mr-ink)" }}>
              <span className="mr-row" style={{ justifyContent: "space-between" }}><strong style={{ fontSize: 15 }}>{x.name}</strong><kbd className="mr-mono" style={{ opacity: 0.7 }}>⌘{i + 1}</kbd></span>
              <span style={{ opacity: 0.8 }}>{x.what}</span>
            </button>
          ))}
        </div>
        <div style={{ display: "flex", flexDirection: "column", padding: "0 10px 10px", minHeight: 120 }}>
          <span className="mr-dim" style={{ padding: "4px 8px 8px" }}>
            {mode === "review" ? "Waiting for your review" : mode === "address" ? "Your open PRs" : mode === "plan" ? "Continue a plan" : "Recent prompts"}
            {(mode === "review" || mode === "address") && prs === null && " · loading…"}
          </span>
          {items.length === 0 && prs !== null && <span className="mr-dim" style={{ padding: "4px 8px" }}>Nothing here.</span>}
          {items.map((it, i) => (
            <button key={i} type="button" onClick={() => void start(it.value)} onMouseEnter={() => setSel(i)}
              className="mr-row" style={{ padding: "8px", border: 0, borderRadius: "var(--mr-radius)", background: i === sel ? "var(--mr-well)" : "transparent", color: "var(--mr-ink)", textAlign: "left", cursor: "pointer", font: "inherit" }}>
              <span className="mr-mono mr-dim" style={{ width: 64, flexShrink: 0 }}>{it.ref}</span>
              <span className="mr-grow mr-ellipsis">{it.title}</span>
              <span style={{ color: it.hot ? "var(--mr-needs-ink)" : "var(--mr-ink-3)", fontWeight: it.hot ? 700 : 400 }}>{it.meta}</span>
            </button>
          ))}
          {error && <span style={{ color: "var(--mr-error)", padding: "4px 8px" }}>{error}</span>}
        </div>
        <div className="mr-row mr-dim" style={{ padding: "10px 18px", background: "var(--mr-band)" }}>
          <span>⌘1–4 switch · ↑↓ pick · ↵ start · esc close</span>
          <span className="mr-grow" />
          <span>New worktree per session arrives in M2</span>
        </div>
      </div>
    </div>
  );
}
