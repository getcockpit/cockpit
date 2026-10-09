import { useEffect, useMemo, useState } from "react";
import { Bar, DecisionCard, Key, Lamp, Lamps, Sparkline, StateMark, type Answer } from "./components";
import { pickDecision, pickTile } from "./picker/pick";
import { api, useAppState } from "./state/store";
import type { PendingAsk, SessionState } from "./state/types";

const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);

export default function App() {
  const state = useAppState();
  const sessions = state.order.map((id) => state.sessions[id]);
  const tiles = useMemo(() => sessions.map((s) => ({ s, tile: pickTile(s) })), [sessions]);
  const asks = sessions.flatMap((s) => s.pending.map((a) => ({ s, a })));
  const count = (k: string) => tiles.filter((t) => t.tile.state === k).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100%" }}>
      <header className="mr-band mr-row" style={{ padding: "14px 24px" }}>
        <strong style={{ fontSize: 15 }}>Minority report</strong>
        <span className="mr-dim">Wall</span>
        <span className="mr-grow" />
        <span className="mr-mono mr-ink2">5-hour {pct(state.usage.fiveHour)}</span>
        <span className="mr-mono mr-dim" title={state.sidecar.claude ?? ""}>{state.sidecar.up ? "● sidecar" : "○ sidecar"}</span>
      </header>

      <Lamps>
        <Lamp value={asks.length} label="Needs you" on={asks.length > 0 && "needs"} />
        <Lamp value={count("error")} label="Errors" on={count("error") > 0 && "error"} />
        <Lamp value={count("almost")} label="Almost done" on={count("almost") > 0 && "plain"} />
        <Lamp value={count("working") + count("starting")} label="Running" on={count("working") > 0 && "plain"} />
        <Lamp value={count("idle") + count("done")} label="To review" on={count("idle") + count("done") > 0 && "plain"} />
      </Lamps>

      <main style={{ flex: 1, display: "flex", flexDirection: "column", gap: 20, padding: "16px 24px 24px" }}>
        <StartBar />

        {asks.length > 0 && (
          <section aria-label="Needs you" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <h2 className="mr-h"><span style={{ color: "var(--mr-needs-ink)" }}>◆</span>Needs you <span className="mr-dim">{asks.length}</span></h2>
            <div className="mr-queue">
              {asks.map(({ s, a }) => <AskRow key={a.requestId} s={s} a={a} />)}
            </div>
          </section>
        )}

        <section aria-label="Sessions" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <h2 className="mr-h">Sessions <span className="mr-dim">{sessions.length}</span></h2>
          {sessions.length === 0 ? (
            <p className="mr-dim" style={{ margin: 0 }}>No sessions yet. Start one above.</p>
          ) : (
            <div className="mr-grid">
              {tiles.map(({ s, tile }) => (
                <div key={s.id} className="mr-tile" data-s={tile.state}>
                  <div className="mr-flag" />
                  <div className="mr-tbody">
                    <div className="mr-row" style={{ alignItems: "baseline" }}>
                      <strong className="mr-grow mr-ellipsis" style={{ fontSize: 15 }}>{s.title || "Untitled"}</strong>
                      <StateMark s={tile.state} />
                    </div>
                    <span className="mr-mono mr-dim mr-ellipsis" style={{ fontSize: 12 }}>{s.cwd}</span>
                    <div className="mr-row"><div className="mr-grow"><Bar value={tile.progress} tone={tile.state === "needs_you" ? "needs" : undefined} /></div><span className="mr-mono mr-ink2" style={{ fontSize: 12 }}>{tile.progressLabel || tile.step}</span></div>
                    <div className="mr-row" style={{ alignItems: "flex-end" }}>
                      <span className="mr-grow mr-ink2">{tile.doing}</span>
                      <Sparkline values={s.activity} />
                    </div>
                    <SessionControls s={s} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function AskRow({ s, a }: { s: SessionState; a: PendingAsk }) {
  const { spec } = useMemo(() => pickDecision(a), [a]);
  const answer = (x: Answer) => {
    const decision =
      x.kind === "deny" ? { behavior: "deny", message: x.note ?? "The user denied this." }
      : x.kind === "answer" ? { behavior: "allow", updatedInput: { ...a.input, answers: x.answers } }
      : { behavior: "allow", updatedInput: a.input, ...(x.always && a.kind === "permission" && a.suggestions ? { updatedPermissions: a.suggestions } : {}) };
    void api.respond(s.id, a.requestId, decision);
  };
  return (
    <div className="mr-qrow">
      <div className="mr-flag" />
      <div className="mr-qbody">
        <span className="mr-mono mr-dim">{s.cwd.split("/").slice(-2).join("/")} / {s.title.slice(0, 60)}</span>
        <DecisionCard spec={spec} onAnswer={answer} />
      </div>
    </div>
  );
}

function SessionControls({ s }: { s: SessionState }) {
  const [text, setText] = useState("");
  const live = s.status !== "ended" && s.status !== "error";
  if (!live) return null;
  return (
    <form className="mr-row" onSubmit={(e) => { e.preventDefault(); if (text.trim()) { void api.send(s.id, text.trim()); setText(""); } }}>
      <input className="mr-input" style={{ minHeight: 32, fontSize: 13, background: "var(--mr-well)" }} placeholder="Steer this session…" value={text} onChange={(e) => setText(e.target.value)} aria-label={`Message ${s.title}`} />
      <Key k="esc" onClick={() => void api.interrupt(s.id)}>Interrupt</Key>
    </form>
  );
}

function StartBar() {
  const [cwd, setCwd] = useState(() => { try { return localStorage.getItem("mr.cwd") ?? "~/"; } catch { return "~/"; } });
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { try { localStorage.setItem("mr.cwd", cwd); } catch { /* per-viewer convenience only */ } }, [cwd]);
  const start = async () => {
    setError("");
    try { await api.start(cwd, prompt.trim()); setPrompt(""); } catch (e) { setError(String(e)); }
  };
  return (
    <form className="mr-row" onSubmit={(e) => { e.preventDefault(); if (prompt.trim()) void start(); }} style={{ flexWrap: "wrap" }}>
      <span className="mr-mono" style={{ padding: "2px 6px", background: "var(--mr-ink)", color: "var(--mr-tile)" }}>⌘K</span>
      <input className="mr-input mr-mono" style={{ flex: "0 1 260px", fontSize: 13 }} value={cwd} onChange={(e) => setCwd(e.target.value)} aria-label="Project folder" />
      <input className="mr-input" placeholder="What should Claude do?" value={prompt} onChange={(e) => setPrompt(e.target.value)} aria-label="Prompt" />
      <Key k="↵" tone="primary" disabled={!prompt.trim()}>Start</Key>
      {error && <span style={{ color: "var(--mr-error)", width: "100%" }}>{error}</span>}
    </form>
  );
}
