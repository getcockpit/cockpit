import { keyOf } from "../components/keys";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Key } from "../components";
import { Markdown } from "../components/Markdown";
import { decideQuestion, docApi, sendDocFeedback, isOpenQuestion, orderedBlocks, SECTION_LABEL, type Block, type Doc } from "../state/docs";
import { api } from "../state/store";
import type { AppState } from "../state/types";

// The working doc as a map (decision 12): the overview shows every block's takeaway at reading size,
// sized to its text; opening one zooms into a reading pane with the whole block and an outline of the
// rest; a walkthrough tours them in /prd order; questions are decided in place; everything is
// editable and annotateable. ⌘-click = go deeper, ⌥-click = discover in a side session (decision 21).
// No fixed card sizes and no scale-to-fit: real docs have 10+ blocks with long bodies (MR-77).

export function DocMap({ doc, state, onBack, onOpenSession }: { doc: Doc; state: AppState; onBack: () => void; onOpenSession: (id: string) => void }) {
  const blocks = useMemo(() => orderedBlocks(doc), [doc]);
  const [step, setStep] = useState(0); // 0 = overview, n = blocks[n-1]
  const [deep, setDeep] = useState<Record<string, boolean>>({});
  const [threads, setThreads] = useState<Record<string, string>>({});
  const pane = useRef<HTMLDivElement>(null);
  // Each step starts at the top of its block.
  useLayoutEffect(() => { pane.current?.scrollTo({ top: 0 }); }, [step]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || (e.target as HTMLElement)?.isContentEditable;
      if (typing) return;
      if (keyOf(e) === "Escape") { e.preventDefault(); if (step) setStep(0); else onBack(); }
      if (keyOf(e) === " ") { e.preventDefault(); setStep((s) => (s >= blocks.length ? 0 : s + 1)); }
      if (keyOf(e) === "ArrowLeft") setStep((s) => Math.max(0, s - 1));
      if (keyOf(e) === "ArrowRight") setStep((s) => Math.min(blocks.length, s + 1));
      if (keyOf(e) === "o") setStep(0);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [blocks.length, step, onBack]);

  const focus = step ? blocks[step - 1] ?? null : null;

  const session = doc.session_id ? state.sessions[doc.session_id] : null;
  const live = !!session && session.status !== "ended" && session.status !== "error";
  const open = blocks.filter(isOpenQuestion);
  // What the latest version changed (MR-51): blocks set since the last regenerate.
  const changed = doc.version > 1 ? blocks.filter((b) => b.since === doc.version) : [];
  const [onlyChanged, setOnlyChanged] = useState(false);
  const pending = doc.pending_notes.length + doc.pending_changes.length;

  const [sent, setSent] = useState("");
  // Delete takes two clicks; the second says what it does.
  const [confirmDelete, setConfirmDelete] = useState(false);
  const remove = async () => {
    if (!confirmDelete) { setConfirmDelete(true); return; }
    await docApi.archive(doc);
    onBack();
  };
  const sendFeedback = async (regenerate: boolean) => {
    const id = await sendDocFeedback(doc, session, regenerate);
    setSent(regenerate ? "Sent. Claude is writing the next version; it appears here as it lands." : "Sent to the plan session.");
    if (!live) onOpenSession(id);
  };
  const build = async () => {
    const id = await api.start(session?.cwd ?? "~/", `Implement the plan in working doc "${doc.title}" (doc_id ${doc.id}). First read it with the mr doc_read tool and follow its decisions. If you learn something that changes the plan, update the doc's blocks with doc_set_block and add a [log] block.`, "blank");
    onOpenSession(id);
  };
  // ⌘↵ does what the primary button says: regenerate with your input, or build when there's none.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (!(e.metaKey && keyOf(e) === "Enter")) return;
      e.preventDefault();
      if (pending > 0) void sendFeedback(true); else if (blocks.length) void build();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });
  const discover = async (b: Block) => {
    const id = await api.start(session?.cwd ?? "~/", `Side thread for working doc "${doc.title}" (doc_id ${doc.id}), block [${b.section}] "${b.takeaway}". Explore and report back briefly: what already exists in this codebase that relates to it, alternatives worth considering, and any risk the doc misses. Don't change code. If you find something important, add a note-worthy [log] block to the doc.`, "blank");
    setThreads((t) => ({ ...t, [b.id]: id }));
  };
  const clickBlock = (b: Block, i: number, e: React.MouseEvent) => {
    setStep(i + 1);
    if (e.metaKey) setDeep((d) => ({ ...d, [b.id]: true }));
    if (e.altKey && !threads[b.id]) void discover(b);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <header className="mr-band mr-row" style={{ padding: "14px 24px" }}>
        <button type="button" onClick={onBack} className="mr-key" style={{ minHeight: 30 }}><kbd>esc</kbd>Wall</button>
        <strong style={{ fontSize: 15 }}>{doc.title}</strong>
        <span className="mr-mono mr-dim">v{doc.version} · {blocks.length} blocks</span>
        <span className="mr-grow" />
        {session && <button type="button" className="mr-key" style={{ minHeight: 30 }} onClick={() => onOpenSession(session.id)}>Open the plan session{live ? "" : " (ended)"}</button>}
        <button type="button" className="mr-key" data-mr="DocDelete" data-mr-source={doc.id} style={{ minHeight: 30, ...(confirmDelete ? { background: "var(--mr-error)", color: "var(--mr-tile)" } : {}) }}
          onClick={() => void remove()} onBlur={() => setConfirmDelete(false)}>{confirmDelete ? "Click again to delete this doc" : "Delete doc"}</button>
      </header>

      <main style={{ flex: 1, minHeight: 0, display: "flex", gap: 16, padding: 16 }}>
        <section style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column", background: "var(--mr-well)" }}>
            {blocks.length === 0 && <div className="mr-dim" style={{ padding: 24 }}>No blocks yet. Claude adds them with the doc tools as it plans.</div>}
            {!focus ? (
              <div ref={pane} key="overview" className="mr-zoom-in" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 16, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gridAutoRows: "min-content", gap: 12, alignContent: "start" }}>
                {blocks.map((b, i) => (
                  <BlockTile key={b.id} doc={doc} b={b} dim={onlyChanged && !changed.includes(b)} changedIn={changed.includes(b) ? doc.version : null} thread={threads[b.id]} onClick={(e) => clickBlock(b, i, e)} />
                ))}
              </div>
            ) : (
              <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
                {/* The rest of the map stays one click away while you read. */}
                <nav aria-label="Blocks" data-mr="DocOutline" data-mr-source={doc.id} style={{ flex: "0 0 240px", overflowY: "auto", padding: "16px 0 16px 16px", display: "flex", flexDirection: "column", gap: 2 }}>
                  <button type="button" onClick={() => setStep(0)} className="mr-dim" style={{ border: 0, background: "transparent", font: "inherit", fontSize: 12, textAlign: "left", padding: "6px 10px", cursor: "zoom-out" }}>↖ Overview <kbd className="mr-mono">o</kbd></button>
                  {blocks.map((b, i) => {
                    const here = b.id === focus.id, openQ = isOpenQuestion(b);
                    return (
                      <button key={b.id} type="button" aria-current={here || undefined} onClick={(e) => clickBlock(b, i, e)} title={b.takeaway}
                        style={{ border: 0, padding: "6px 10px", font: "inherit", textAlign: "left", cursor: "pointer", color: "var(--mr-ink)", background: here ? "var(--mr-tile)" : "transparent", boxShadow: here ? "inset 3px 0 0 var(--mr-selected)" : openQ ? "inset 3px 0 0 var(--mr-needs)" : "none", display: "flex", flexDirection: "column", gap: 1 }}>
                        <span style={{ fontSize: 11, color: openQ ? "var(--mr-needs-ink)" : "var(--mr-ink-3)", fontWeight: 700 }}>{kickerOf(b)}</span>
                        <span className="mr-ellipsis" style={{ fontSize: 13, fontWeight: here ? 700 : 400 }}>{b.takeaway || "(no takeaway)"}</span>
                      </button>
                    );
                  })}
                </nav>
                <div ref={pane} style={{ flex: 1, minWidth: 0, overflowY: "auto", padding: "16px 16px 80px" }}>
                  <BlockOpen key={focus.id} doc={doc} b={focus} changedIn={changed.includes(focus) ? doc.version : null}
                    deep={!!deep[focus.id]} thread={threads[focus.id]} onDecide={(label) => void decideQuestion(doc, focus.id, label, session)}
                    onDeeper={() => setDeep((d) => ({ ...d, [focus.id]: !d[focus.id] }))} onDiscover={() => void discover(focus)} onOpenThread={onOpenSession}
                    onAsk={(q) => live && session ? void api.send(session.id, `About block [${focus.section}] "${focus.takeaway}" of doc ${doc.id}: ${q}`) : undefined} />
                </div>
              </div>
            )}
            <div className="mr-row" style={{ flex: "none", padding: "10px 14px", background: "var(--mr-tile)", borderTop: "2px solid var(--mr-well)" }}>
              <span className="mr-mono mr-dim" style={{ flex: "none" }}>{focus ? `${step} / ${blocks.length}` : "Overview"}</span>
              <span className="mr-grow mr-ellipsis" style={{ fontWeight: 700, minWidth: 0 }}>{focus ? SECTION_LABEL[focus.section] ?? focus.section : "At a glance. Space walks through it block by block."}</span>
              {changed.length > 0 && !focus && <Key tone={onlyChanged ? "primary" : undefined} onClick={() => setOnlyChanged((x) => !x)}>{onlyChanged ? "Show everything" : `What changed in v${doc.version} · ${changed.length}`}</Key>}
              <Key k="←" onClick={() => setStep((s) => Math.max(0, s - 1))}>Back</Key>
              <Key k="space" tone="primary" onClick={() => setStep((s) => (s >= blocks.length ? 0 : s + 1))}>{step === 0 ? "Walk through" : step >= blocks.length ? "Zoom out" : "Next"}</Key>
            </div>
          </div>
          <div className="mr-row mr-dim" style={{ flexWrap: "wrap", fontSize: 12 }}>
            <span><b className="mr-mono">click</b> open</span><span><b className="mr-mono">⌘-click</b> go deeper</span><span><b className="mr-mono">⌥-click</b> discover in a side session</span><span><b className="mr-mono">esc</b> up a level</span><span><b className="mr-mono">o</b> overview</span>
          </div>
        </section>

        {/* One "next step" column (MR-44): decide what's open, then send your input or build. */}
        <aside data-mr="DocNext" data-mr-source={doc.id} style={{ flex: "0 0 340px", display: "flex", flexDirection: "column", gap: 12, overflowY: "auto" }}>
          {open.length > 0 && (
            <>
              <h2 className="mr-h"><span style={{ color: "var(--mr-needs-ink)" }}>◆</span>Decide first <span className="mr-dim">{open.length}</span></h2>
              {open.map((b) => (
                <div key={b.id} style={{ padding: 12, background: "var(--mr-tile)", boxShadow: "inset 4px 0 0 var(--mr-needs)", display: "flex", flexDirection: "column", gap: 8 }}>
                  <button type="button" onClick={() => setStep(blocks.indexOf(b) + 1)} style={{ border: 0, padding: 0, background: "transparent", font: "inherit", fontWeight: 700, color: "var(--mr-ink)", textAlign: "left", cursor: "pointer" }}>{b.takeaway}</button>
                  {(b.data?.options ?? []).map((o) => (
                    <button key={o.label} type="button" onClick={() => void decideQuestion(doc, b.id, o.label, session)} style={{ display: "flex", flexDirection: "column", gap: 2, padding: "8px 10px", border: 0, background: "var(--mr-well)", font: "inherit", color: "var(--mr-ink)", textAlign: "left", cursor: "pointer" }}>
                      <strong>{o.label}</strong><span className="mr-dim" style={{ fontSize: 12 }}>{o.description}</span>
                    </button>
                  ))}
                </div>
              ))}
            </>
          )}

          <h2 className="mr-h" style={{ marginTop: open.length ? 8 : 0 }}>Your input <span className="mr-dim">{pending}</span></h2>
          {pending === 0 && <span className="mr-dim">Click any block to open it, then edit its text or add a note. Your input goes to Claude in one go.</span>}
          {doc.pending_changes.map((c, i) => <div key={`c${i}`} style={{ padding: "8px 12px", background: "var(--mr-tile)" }}>Edited “{doc.blocks[c]?.takeaway ?? c}”</div>)}
          {doc.pending_notes.map(([bid, t], i) => (
            <button key={`n${i}`} type="button" onClick={() => setStep(blocks.findIndex((b) => b.id === bid) + 1)} style={{ display: "flex", flexDirection: "column", gap: 2, padding: "8px 12px", border: 0, background: "var(--mr-tile)", textAlign: "left", font: "inherit", color: "inherit", cursor: "pointer" }}>
              <span className="mr-dim" style={{ fontSize: 12 }}>on “{doc.blocks[bid]?.takeaway ?? bid}”</span><span>{t}</span>
            </button>
          ))}

          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 4 }}>
            {pending > 0 && <Key k="⌘↵" tone="primary" onClick={() => void sendFeedback(true)}>Regenerate with {pending} {pending === 1 ? "change" : "changes"}</Key>}
            {pending > 0 && <Key onClick={() => void sendFeedback(false)}>Just send, don't regenerate</Key>}
            <Key k={pending === 0 ? "⌘↵" : undefined} tone={pending === 0 && open.length === 0 ? "primary" : undefined} onClick={() => void build()} disabled={!blocks.length}>Build from this doc</Key>
            {open.length > 0 && <span className="mr-dim" style={{ fontSize: 12 }}>You can build now, but {open.length === 1 ? "the open question" : `the ${open.length} open questions`} will be left to Claude.</span>}
            {sent && <span style={{ color: "var(--mr-done)" }}>{sent}</span>}
          </div>
        </aside>
      </main>
    </div>
  );
}

const kickerOf = (b: Block) => (b.section === "question" && b.decision ? "Decided" : `${SECTION_LABEL[b.section] ?? b.section}${b.status ? ` · ${b.status}` : ""}`);
const edgeOf = (b: Block) => (isOpenQuestion(b) ? "var(--mr-needs)" : b.decision ? "var(--mr-done)" : "transparent");
const clamp = (lines: number): React.CSSProperties => ({ display: "-webkit-box", WebkitLineClamp: lines, WebkitBoxOrient: "vertical", overflow: "hidden" });

// Overview: a block at reading size, as tall as its text (clamped, so one long block can't swamp the grid).
function BlockTile({ doc, b, dim, changedIn, thread, onClick }: { doc: Doc; b: Block; dim: boolean; changedIn: number | null; thread?: string; onClick: (e: React.MouseEvent) => void }) {
  const openQ = isOpenQuestion(b), kicker = kickerOf(b);
  return (
    <button type="button" data-mr="DocBlock" data-mr-source={`${doc.id}:${b.id}`} onClick={onClick} aria-label={`Open ${kicker}: ${b.takeaway}`}
      style={{ border: 0, borderLeft: `6px solid ${edgeOf(b)}`, padding: "14px 16px", background: "var(--mr-tile)", opacity: dim ? 0.35 : 1, transition: "opacity 200ms", textAlign: "left", font: "inherit", color: "var(--mr-ink)", cursor: "zoom-in", display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
      <span style={{ fontSize: 12, color: openQ ? "var(--mr-needs-ink)" : "var(--mr-ink-3)", fontWeight: 700 }}>{openQ ? "◆ " : b.decision ? "✓ " : ""}{kicker}</span>
      <span style={{ fontSize: 16, lineHeight: 1.3, fontWeight: 700, ...clamp(4) }}>{b.takeaway || "(no takeaway)"}</span>
      {(b.decision || b.key) && <span style={{ fontSize: 13, color: "var(--mr-ink-2)", ...clamp(2) }}>{b.decision ? `→ ${b.decision}` : b.key}</span>}
      {changedIn && <span style={{ fontSize: 12, color: "var(--mr-selected)", fontWeight: 700 }}>● Changed in v{changedIn}</span>}
      {thread && <span style={{ fontSize: 12, color: "var(--mr-selected)" }}>⌕ side session running</span>}
    </button>
  );
}

// Zoomed in: the whole block in a reading column, with its decision, note and ask.
function BlockOpen(props: {
  doc: Doc; b: Block; deep: boolean; thread?: string; changedIn: number | null;
  onDecide: (label: string) => void; onDeeper: () => void; onDiscover: () => void; onOpenThread: (id: string) => void; onAsk: (q: string) => void;
}) {
  const { doc, b, deep, thread } = props;
  const [note, setNote] = useState("");
  const [ask, setAsk] = useState("");
  const question = b.section === "question";
  const kicker = kickerOf(b);
  const style: React.CSSProperties = { maxWidth: 820, margin: "0 auto", boxSizing: "border-box", background: "var(--mr-tile)", borderLeft: `6px solid ${edgeOf(b)}` };
  return (
    <div data-mr="DocBlockOpen" data-mr-source={`${doc.id}:${b.id}`} className="mr-zoom-in" style={{ ...style, padding: "22px 26px", display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="mr-row" style={{ alignItems: "baseline" }}>
        <span className="mr-grow" contentEditable suppressContentEditableWarning spellCheck={false} aria-label="Edit takeaway"
          onBlur={(e) => { const v = e.currentTarget.textContent ?? ""; if (v.trim() && v !== b.takeaway) void docApi.edit(doc, b.id, "takeaway", v.trim()); }}
          style={{ fontSize: 22, fontWeight: 700, outline: "none", borderBottom: "1px dotted var(--mr-ink-3)", cursor: "text" }}>{b.takeaway}</span>
        <span className="mr-dim" style={{ whiteSpace: "nowrap" }}>{kicker}</span>
      </div>
      {props.changedIn && b.was && <span style={{ color: "var(--mr-selected)" }}>Changed in v{props.changedIn}. Was: <s className="mr-dim">{b.was}</s></span>}
      <span contentEditable suppressContentEditableWarning aria-label="Edit key detail" className="mr-ink2"
        onBlur={(e) => { const v = e.currentTarget.textContent ?? ""; if (v.trim() && v !== b.key) void docApi.edit(doc, b.id, "key", v.trim()); }}
        style={{ outline: "none", cursor: "text" }}>{b.key}</span>

      {question && b.data?.options && (
        <fieldset style={{ margin: 0, padding: 0, border: 0, display: "flex", flexDirection: "column", gap: 4 }}>
          <legend className="mr-dim" style={{ marginBottom: 6 }}>{b.decision ? "Decided. You can change it." : "Pick one to record the decision."}</legend>
          {b.data.options.map((o, i) => (
            <label key={i} className="mr-row" style={{ padding: "10px 12px", background: b.decision === o.label ? "var(--mr-well)" : "transparent", cursor: "pointer", alignItems: "baseline" }}>
              <input type="radio" name={`q-${b.id}`} checked={b.decision === o.label} onChange={() => void props.onDecide(o.label)} style={{ accentColor: "var(--mr-ink)" }} />
              <span style={{ display: "flex", flexDirection: "column" }}><strong>{o.label}</strong><span className="mr-dim">{o.description}</span></span>
            </label>
          ))}
        </fieldset>
      )}

      {(deep || !question) && b.body && <Markdown text={b.body} />}

      {thread && <button type="button" className="mr-row" onClick={() => props.onOpenThread(thread)} style={{ padding: "8px 10px", border: 0, background: "var(--mr-well)", font: "inherit", color: "inherit", cursor: "pointer", textAlign: "left" }}>⌕ Side session running — open it ↗</button>}

      <form className="mr-row" onSubmit={(e) => { e.preventDefault(); if (note.trim()) { void docApi.note(doc, b.id, note.trim()); setNote(""); } }}>
        <input className="mr-input" style={{ minHeight: 32, fontSize: 13, background: "var(--mr-well)" }} placeholder="Note on this block (sent with Regenerate)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note on this block" />
      </form>
      <form className="mr-row" onSubmit={(e) => { e.preventDefault(); if (ask.trim()) { props.onAsk(ask.trim()); setAsk(""); } }}>
        <input className="mr-input" style={{ minHeight: 32, fontSize: 13, background: "var(--mr-well)" }} placeholder="Ask about this block" value={ask} onChange={(e) => setAsk(e.target.value)} aria-label="Ask about this block" />
      </form>
      <div className="mr-row" style={{ flexWrap: "wrap" }}>
        {question && b.body && <Key k="⌘-click" onClick={props.onDeeper}>{deep ? "Less detail" : "Show the reasoning"}</Key>}
        <Key k="⌥-click" onClick={props.onDiscover} disabled={!!thread}>Discover in a side session</Key>
        <span className="mr-dim" style={{ fontSize: 12 }}>Click text to edit</span>
      </div>
    </div>
  );
}
