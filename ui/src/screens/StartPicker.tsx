import { keyOf } from "../components/keys";
import { FolderPicker, useWorkFolder } from "../components/FolderPicker";
import { cleanTitle } from "../picker/title";
import { prRepo, prSlug, rememberPrRepo } from "../state/prRepo";
import { shortError } from "../components/ErrorLine";
import { useEffect, useMemo, useRef, useState } from "react";
import { Key } from "../components";
import { api, type Pr } from "../state/store";
import type { AppState, SessionKind } from "../state/types";

// ⌘K start picker (decision 18): Review / Address / Plan / Blank, each with its own suggestions.
const MODES: { id: SessionKind; name: string; what: string; placeholder: string }[] = [
  { id: "blank", name: "Blank", what: "Any task, straight away", placeholder: "What should Claude do?" },
  { id: "plan", name: "Plan", what: "A working doc first, code later", placeholder: "Describe what you want to build…" },
  { id: "review", name: "Review", what: "Your /review on a PR", placeholder: "PR number or URL, e.g. 4412" },
  { id: "address", name: "Address", what: "Your /pr-address, thread by thread", placeholder: "Your PR number" },
];

// What each mode actually sends to Claude Code. Review/Address use the user's own commands.
export function promptFor(mode: SessionKind, text: string): string {
  const t = text.trim();
  if (mode === "review") return `/review ${t}`;
  if (mode === "address") return `/pr-address ${t}`;
  if (mode === "plan") return `Plan this with me before any code: ${t}. Write the plan as a working document using the mr doc tools.`;
  return t;
}

// What happens when you press Start, per kind (shown in the footer instead of stale copy).
const HOW: Record<SessionKind, string> = {
  blank: "Runs in its own git worktree, so your checkout stays clean",
  plan: "Writes a working doc you annotate; no code until you say so",
  review: "Runs your /review and shows its findings step by step",
  address: "Runs your /pr-address and walks each reviewer thread",
};

type Item = { ref: string; title: string; meta: string; hot: boolean; value: string; repo?: string };

export function StartPicker({ state, onClose, onStarted, initialText = "", initialMode }: { state: AppState; onClose: () => void; onStarted: (id: string) => void; initialText?: string; initialMode?: SessionKind }) {
  // Opens on the kind you used last (F6); dictated text always starts a blank session.
  const [mode, setModeRaw] = useState<SessionKind>(() => { if (initialMode) return initialMode; if (initialText) return "blank"; try { return (localStorage.getItem("mr.mode") as SessionKind) || "blank"; } catch { return "blank"; } });
  const setMode = (m: SessionKind) => { setModeRaw(m); try { localStorage.setItem("mr.mode", m); } catch { /* convenience only */ } };
  const [text, setText] = useState(initialText);
  const [cwd, setCwd] = useWorkFolder();
  const [prs, setPrs] = useState<Pr[] | null>(null);
  const [error, setError] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { input.current?.focus(); }, [mode]);
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
        ref: `#${p.number}`, value: p.url, repo: p.repository?.nameWithOwner, title: `${p.title}${p.author ? ` · @${p.author.login}` : ""}`,
        meta: mode === "address" ? `${p.repository?.nameWithOwner ?? ""}${p.reviewDecision === "CHANGES_REQUESTED" ? " · changes requested" : ""}` : (p.repository?.nameWithOwner ?? ""),
        hot: mode === "address" ? p.reviewDecision === "CHANGES_REQUESTED" : true,
      }));
    }
    const recent = state.order.map((id) => state.sessions[id]).filter((s) => s.kind === mode).reverse().slice(0, 5);
    return recent.map((s) => ({ ref: "", value: cleanTitle(s.title, 400), title: cleanTitle(s.title), meta: new Date(s.startedAt).toLocaleDateString(), hot: false }));
  }, [mode, prs, state]);

  // PR work runs in the PR's own clone (MR-48); if it can't be found, ask once and remember.
  const [askRepo, setAskRepo] = useState<{ slug: string; value: string } | null>(null);
  const start = async (value: string, repo?: string) => {
    if (!value.trim()) return;
    setError("");
    try {
      let where = cwd;
      const slug = mode === "review" || mode === "address" ? repo ?? prSlug(value) : null;
      if (slug) {
        const found = await prRepo(slug);
        if (!found) { setAskRepo({ slug, value }); return; }
        where = found;
      }
      onStarted(await api.start(where, promptFor(mode, value), mode));
    } catch (e) { setError(shortError(e)); }
  };
  const useFolderFor = async (path: string) => {
    if (!askRepo) return;
    rememberPrRepo(askRepo.slug, path);
    try { onStarted(await api.start(path, promptFor(mode, askRepo.value), mode)); } catch (e) { setError(shortError(e)); }
  };

  // A PR starts its review straight away; a past prompt only fills the box, so it can be edited
  // instead of silently starting a duplicate session.
  const pick = (it: Item) => {
    if (mode === "review" || mode === "address") void start(it.value, it.repo);
    else { setText(it.value); input.current?.focus(); }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (keyOf(e) === "Escape") { e.preventDefault(); onClose(); }
    else if (e.metaKey && ["1", "2", "3", "4"].includes(keyOf(e))) { e.preventDefault(); setMode(MODES[Number(keyOf(e)) - 1].id); }
    else if (keyOf(e) === "ArrowDown") { e.preventDefault(); setSel((x) => Math.min(items.length - 1, x + 1)); }
    else if (keyOf(e) === "ArrowUp") { e.preventDefault(); setSel((x) => Math.max(0, x - 1)); }
    else if (keyOf(e) === "Enter" && !text.trim() && items[sel]) { e.preventDefault(); pick(items[sel]); }
  };

  const m = MODES.find((x) => x.id === mode)!;
  return (
    <div role="dialog" aria-label="Start something" onKeyDown={onKey}
      style={{ position: "fixed", inset: 0, display: "flex", justifyContent: "center", alignItems: "flex-start", padding: "96px 24px", background: "rgba(21,24,27,.35)", zIndex: 10 }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ width: "100%", maxWidth: 880, background: "var(--mr-tile)", display: "flex", flexDirection: "column" }}>
        <form className="mr-row" style={{ padding: "14px 18px", background: "var(--mr-band)" }} onSubmit={(e) => { e.preventDefault(); void start(text); }}>
          {mode === "review" || mode === "address"
            ? <span className="mr-dim" style={{ flex: "0 1 240px", padding: "0 8px" }} title="Review and Address run in the PR's own clone">Runs in the PR's repo</span>
            : <FolderPicker value={cwd} onChange={(p) => { setCwd(p); input.current?.focus(); }} extra={[...new Set(state.order.map((id) => state.sessions[id]).reverse().map((x) => x.repo ?? x.cwd))].slice(0, 5)} />}
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
            {mode === "review" ? "Waiting for your review" : mode === "address" ? "Your open PRs" : "Reuse a recent prompt"}
            {(mode === "review" || mode === "address") && prs === null && " · loading…"}
          </span>
          {items.length === 0 && prs !== null && <span className="mr-dim" style={{ padding: "4px 8px" }}>Nothing here.</span>}
          {items.map((it, i) => (
            <button key={i} type="button" onClick={() => pick(it)} onMouseEnter={() => setSel(i)}
              className="mr-row" style={{ padding: "8px", border: 0, borderRadius: "var(--mr-radius)", background: i === sel ? "var(--mr-well)" : "transparent", color: "var(--mr-ink)", textAlign: "left", cursor: "pointer", font: "inherit" }}>
              <span className="mr-mono mr-dim" style={{ width: 64, flexShrink: 0 }}>{it.ref}</span>
              <span className="mr-grow mr-ellipsis">{it.title}</span>
              <span style={{ color: it.hot ? "var(--mr-needs-ink)" : "var(--mr-ink-3)", fontWeight: it.hot ? 700 : 400 }}>{it.meta}</span>
            </button>
          ))}
          {askRepo && (
            <div data-mr="AskRepo" className="mr-row" style={{ gap: 10, padding: 10, background: "var(--mr-well)", boxShadow: "inset 4px 0 0 var(--mr-needs)" }}>
              <span className="mr-grow">Where is <b className="mr-mono">{askRepo.slug}</b> cloned on this Mac? It runs there, and it's remembered.</span>
              <FolderPicker value="" onChange={(p) => void useFolderFor(p)} extra={[]} />
            </div>
          )}
          {error && <span style={{ color: "var(--mr-error)", padding: "4px 8px" }}>{error}</span>}
        </div>
        <div className="mr-row mr-dim" style={{ padding: "10px 18px", background: "var(--mr-band)" }}>
          <span>⌘1–4 switch · ↑↓ pick · ↵ start · esc close</span>
          <span className="mr-grow" />
          <span>{HOW[mode]}</span>
        </div>
      </div>
    </div>
  );
}
