import { useEffect, useMemo, useState } from "react";
import { Bar, Key, Lamp, Lamps, Sparkline, StateMark } from "./components";
import { pickTile } from "./picker/pick";
import { AskRow } from "./screens/AskRow";
import { Focus } from "./screens/Focus";
import { StartPicker } from "./screens/StartPicker";
import { useAppState } from "./state/store";

const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);

export default function App() {
  const state = useAppState();
  const [focus, setFocus] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key.toLowerCase() === "k") { e.preventDefault(); setPicker(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const overlay = picker && <StartPicker state={state} onClose={() => setPicker(false)} onStarted={(id) => { setPicker(false); setFocus(id); }} />;
  const focused = focus ? state.sessions[focus] : null;
  if (focused) return <>{<Focus s={focused} onBack={() => setFocus(null)} />}{overlay}</>;
  return <><Wall state={state} onOpen={setFocus} onStart={() => setPicker(true)} />{overlay}</>;
}

function Wall({ state, onOpen, onStart }: { state: ReturnType<typeof useAppState>; onOpen: (id: string) => void; onStart: () => void }) {
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
        <span className="mr-mono mr-dim" title={state.sidecar.claude ?? ""}>{state.sidecar.up ? "● claude" : "○ claude"}</span>
      </header>

      <Lamps>
        <Lamp value={asks.length} label="Needs you" on={asks.length > 0 && "needs"} />
        <Lamp value={count("error")} label="Errors" on={count("error") > 0 && "error"} />
        <Lamp value={count("almost")} label="Almost done" on={count("almost") > 0 && "plain"} />
        <Lamp value={count("working") + count("starting")} label="Running" on={count("working") > 0 && "plain"} />
        <Lamp value={count("idle") + count("done")} label="To review" on={count("idle") + count("done") > 0 && "plain"} />
      </Lamps>

      <main style={{ flex: 1, display: "flex", flexDirection: "column", gap: 20, padding: "16px 24px 24px" }}>
        {asks.length > 0 && (
          <section aria-label="Needs you" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <h2 className="mr-h"><span style={{ color: "var(--mr-needs-ink)" }}>◆</span>Needs you <span className="mr-dim">{asks.length}</span></h2>
            <div className="mr-queue">{asks.map(({ s, a }) => <AskRow key={a.requestId} s={s} a={a} />)}</div>
          </section>
        )}

        <section aria-label="Sessions" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <h2 className="mr-h">Sessions <span className="mr-dim">{sessions.length}</span></h2>
          <div className="mr-grid">
            {tiles.map(({ s, tile }) => (
              <button key={s.id} type="button" className="mr-tile" data-s={tile.state} onClick={() => onOpen(s.id)} aria-label={`Open ${s.title}`}>
                <div className="mr-flag" />
                <div className="mr-tbody">
                  <div className="mr-row" style={{ alignItems: "baseline" }}>
                    <strong className="mr-grow mr-ellipsis" style={{ fontSize: 15 }}>{s.title || "Untitled"}</strong>
                    <StateMark s={tile.state} />
                  </div>
                  <span className="mr-mono mr-dim mr-ellipsis" style={{ fontSize: 12 }}>{s.kind !== "blank" ? `${s.kind} · ` : ""}{s.cwd}</span>
                  <div className="mr-row"><div className="mr-grow"><Bar value={tile.progress} tone={tile.state === "needs_you" ? "needs" : undefined} /></div><span className="mr-mono mr-ink2" style={{ fontSize: 12 }}>{tile.progressLabel || tile.step}</span></div>
                  <div className="mr-row" style={{ alignItems: "flex-end" }}>
                    <span className="mr-grow mr-ink2" style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{tile.doing}</span>
                    <Sparkline values={s.activity} />
                  </div>
                </div>
              </button>
            ))}
            <button type="button" className="mr-tile" onClick={onStart} style={{ alignItems: "center", justifyContent: "center", color: "var(--mr-ink-3)", background: "var(--mr-well)" }}>
              <span className="mr-row" style={{ padding: 16 }}><kbd className="mr-mono" style={{ padding: "2px 6px", background: "var(--mr-ink)", color: "var(--mr-tile)" }}>⌘K</kbd>Start something</span>
            </button>
          </div>
        </section>
      </main>
      <footer className="mr-band mr-row mr-dim" style={{ padding: "8px 24px", fontSize: 12 }}>
        <span>⌘K start · click a tile to focus · esc back · ⌘. interrupt</span>
        <span className="mr-grow" />
        <Key k="⌘K" onClick={onStart}>Start</Key>
      </footer>
    </div>
  );
}
