import { useEffect, useMemo, useState } from "react";
import { Bar, Key, Lamp, Lamps, Sparkline, StateMark } from "./components";
import { pickTile } from "./picker/pick";
import { AskRow } from "./screens/AskRow";
import { Focus } from "./screens/Focus";
import { StartPicker } from "./screens/StartPicker";
import { DocMap } from "./screens/DocMap";
import { isOpenQuestion, useDocs, type Doc } from "./state/docs";
import { useAppState } from "./state/store";

const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);

export default function App() {
  const state = useAppState();
  const docs = useDocs();
  const [focus, setFocus] = useState<string | null>(null);
  const [docId, setDocId] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key.toLowerCase() === "k") { e.preventDefault(); setPicker(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const overlay = picker && <StartPicker state={state} onClose={() => setPicker(false)} onStarted={(id) => { setPicker(false); setDocId(null); setFocus(id); }} />;
  const doc = docId ? docs.find((d) => d.id === docId) : null;
  if (doc) return <>{<DocMap doc={doc} state={state} onBack={() => setDocId(null)} onOpenSession={(id) => { setDocId(null); setFocus(id); }} />}{overlay}</>;
  const focused = focus ? state.sessions[focus] : null;
  if (focused) return <>{<Focus s={focused} docs={docs.filter((d) => d.session_id === focused.id)} onOpenDoc={setDocId} onBack={() => setFocus(null)} />}{overlay}</>;
  return <><Wall state={state} docs={docs} onOpen={setFocus} onOpenDoc={setDocId} onStart={() => setPicker(true)} />{overlay}</>;
}

function Wall({ state, docs, onOpen, onOpenDoc, onStart }: { state: ReturnType<typeof useAppState>; docs: Doc[]; onOpen: (id: string) => void; onOpenDoc: (id: string) => void; onStart: () => void }) {
  const sessions = state.order.map((id) => state.sessions[id]);
  const tiles = useMemo(() => sessions.map((s) => ({ s, tile: pickTile(s) })), [sessions]);
  const asks = sessions.flatMap((s) => s.pending.map((a) => ({ s, a })));
  const count = (k: string) => tiles.filter((t) => t.tile.state === k).length;
  const openQs = docs.flatMap((d) => Object.values(d.blocks).filter(isOpenQuestion).map((b) => ({ d, b })));

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
        <Lamp value={asks.length + openQs.length} label="Needs you" on={asks.length + openQs.length > 0 && "needs"} />
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

        {openQs.length > 0 && (
          <section aria-label="Open questions" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <h2 className="mr-h"><span style={{ color: "var(--mr-needs-ink)" }}>◆</span>Open questions in docs <span className="mr-dim">{openQs.length}</span></h2>
            <div className="mr-queue">
              {openQs.map(({ d, b }) => (
                <button key={`${d.id}:${b.id}`} type="button" className="mr-qrow" onClick={() => onOpenDoc(d.id)} style={{ border: 0, padding: 0, font: "inherit", color: "inherit", textAlign: "left", cursor: "pointer" }}>
                  <div className="mr-flag" />
                  <div className="mr-qbody" style={{ flexDirection: "row", alignItems: "center" }}>
                    <div className="mr-grow" style={{ display: "flex", flexDirection: "column" }}><span className="mr-ink2">{d.title}</span><span className="mr-ask">{b.takeaway}</span></div>
                    <span className="mr-key">Decide ↵</span>
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}

        {docs.length > 0 && (
          <section aria-label="Working docs" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <h2 className="mr-h">Working docs <span className="mr-dim">{docs.length}</span></h2>
            <div className="mr-grid">
              {docs.map((d) => {
                const blocks = Object.values(d.blocks);
                const open = blocks.filter(isOpenQuestion).length;
                return (
                  <button key={d.id} type="button" className="mr-tile" data-s={open ? "needs_you" : "working"} onClick={() => onOpenDoc(d.id)} style={{ minHeight: 96 }}>
                    <div className="mr-flag" />
                    <div className="mr-tbody">
                      <strong style={{ fontSize: 15 }}>{d.title}</strong>
                      <span className="mr-mono mr-dim" style={{ fontSize: 12 }}>v{d.version} · {blocks.length} blocks{open ? ` · ${open} open question${open === 1 ? "" : "s"}` : ""}</span>
                      <span className="mr-ink2 mr-ellipsis">{blocks.find((b) => b.section === "goal")?.takeaway ?? ""}</span>
                    </div>
                  </button>
                );
              })}
            </div>
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
