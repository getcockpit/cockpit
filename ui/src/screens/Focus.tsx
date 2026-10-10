import { keyOf } from "../components/keys";
import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Bar, Key, StateMark } from "../components";
import { pickTile } from "../picker/pick";
import { proseQuestion, replyOptions } from "../picker/queue";
import { sessionTitle } from "../picker/title";
import { summarizeTool } from "../picker/toolSummary";
import { api } from "../state/store";
import type { Diagram, SessionState, TranscriptItem } from "../state/types";
import type { Doc } from "../state/docs";
import { AskRow } from "./AskRow";
import { AddressView, ReviewView } from "./Flows";
import { pointer } from "../components/pointer";
import { FlowDiagram } from "../components/FlowDiagram";
import { ChangeMap } from "./ChangeMap";
import { lazy, Suspense } from "react";
const TerminalPane = lazy(() => import("./Terminal").then((m) => ({ default: m.TerminalPane })));

// Focus view: one session, zoomed in. Decisions first, then plan + changes, then the transcript.
export function Focus({ s, docs, onOpenDoc, onBack, onBuild, onDone }: { s: SessionState; docs: Doc[]; onOpenDoc: (id: string) => void; onBack: () => void; onBuild: (worktree: string) => void; onDone: () => void }) {
  const [isApp, setIsApp] = useState(false);
  useEffect(() => {
    // Sessions working on this app's own repo can rebuild and relaunch it (decision 23).
    invoke<string>("app_repo_path").then((repo) => {
      const name = repo.split("/").filter(Boolean).pop() ?? "";
      setIsApp(s.cwd.startsWith(repo) || (!!s.repo && s.repo === repo) || s.cwd.includes(`/${name}-worktrees/`));
    }).catch(() => setIsApp(false));
  }, [s.cwd, s.repo]);
  const tile = useMemo(() => pickTile(s), [s]);
  const [showRaw, setShowRaw] = useState(false);
  const [term, setTerm] = useState(false);
  const [text, setText] = useState("");
  const live = s.status !== "ended" && s.status !== "error";
  // A turn is in flight: only then does interrupting mean anything (F9).
  const running = s.status === "working" || s.status === "starting";
  const finished = tile.state === "done" || tile.state === "idle" || tile.state === "error" || s.status === "ended";
  const where = [(s.repo ?? s.cwd).split("/").filter(Boolean).pop(), s.branch].filter(Boolean).join(" · ");
  const replies = useMemo(() => nextReplies(s), [s]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (keyOf(e) === "Escape" && !typing) { e.preventDefault(); onBack(); }
      if (keyOf(e) === "." && e.metaKey && running) { e.preventDefault(); void api.interrupt(s.id); }
      if (keyOf(e) === "d" && e.metaKey && e.shiftKey && !s.archivedAt) { e.preventDefault(); onDone(); }
      if (e.altKey && /^[1-3]$/.test(keyOf(e)) && !running && replies[Number(keyOf(e)) - 1]) { e.preventDefault(); void api.send(s.id, replies[Number(keyOf(e)) - 1]); }
      if (keyOf(e) === "r" && e.metaKey) { e.preventDefault(); setShowRaw((x) => !x); }
      if (keyOf(e) === "t" && e.metaKey && s.sdkSessionId) { e.preventDefault(); setTerm((x) => !x); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack, s.id, running, replies]);


  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100%" }}>
      {/* Sticky: the transcript scrolls under it, so state and actions are always in reach. */}
      <header className="mr-band" style={{ padding: "12px 24px 0", display: "flex", flexDirection: "column", gap: 10, position: "sticky", top: 0, zIndex: 5 }}>
        <div className="mr-row" style={{ gap: 14 }}>
          <button type="button" onClick={onBack} className="mr-key" style={{ minHeight: 30 }}><kbd>esc</kbd>Wall</button>
          <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
            <strong className="mr-ellipsis" style={{ fontSize: 18 }} title={s.title}>{sessionTitle(s)}</strong>
            <span className="mr-mono mr-dim mr-ellipsis" style={{ fontSize: 12 }} title={s.cwd}>{s.kind !== "blank" ? `${s.kind} · ` : ""}{where || s.cwd}</span>
          </div>
          <StateMark s={tile.state} />
          <span className="mr-mono mr-ink2">{tile.state === "done" ? tile.step : tile.progressLabel || tile.step}</span>
        </div>
        <div className="mr-row" style={{ gap: 8, paddingBottom: 10 }}>
          <Key k="⌘R" onClick={() => setShowRaw((x) => !x)}>{showRaw ? "Visual" : "Raw transcript"}</Key>
          {s.sdkSessionId && <Key k="⌘T" onClick={() => setTerm((x) => !x)}>{term ? "Back to visual" : "Open in terminal"}</Key>}
          {isApp && <Key k="⌘⇧B" tone="needs" onClick={() => onBuild(s.cwd)}>Rebuild & relaunch</Key>}
          <span className="mr-grow" />
          {running && <Key k="⌘." onClick={() => void api.interrupt(s.id)}>Interrupt</Key>}
          {s.archivedAt
            ? <Key onClick={() => void api.log("ui.session_unarchived", {}, s.id)}>Archived · restore</Key>
            : <Key k="⌘⇧D" tone={finished ? "primary" : undefined} onClick={onDone}>{finished ? "Mark done" : "Stop & mark done"}</Key>}
        </div>
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
          {term ? <Suspense fallback={<span className="mr-dim">Opening terminal…</span>}><TerminalPane s={s} onExit={() => setTerm(false)} /></Suspense> : !showRaw && s.review ? <ReviewView s={s} /> : !showRaw && s.address ? <AddressView s={s} /> : <Transcript items={s.transcript} raw={showRaw} diagrams={s.diagrams} onDiagram={(t) => void api.diagram(s.id, t.id, t.text)} onDiscover={(what) => void api.start(s.cwd, `Side thread about "${s.title}": ${what}. Explain it briefly and point out anything risky. Don't change anything.`, "blank", false)} />}
          {live && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {!running && replies.length > 0 && (
                <div className="mr-row" style={{ gap: 8, flexWrap: "wrap" }} data-mr="SuggestedReplies" data-mr-source={s.id}>
                  <span className="mr-dim">Next:</span>
                  {replies.map((r, i) => <Key key={r} k={i < 3 ? `⌥${i + 1}` : undefined} tone={i === 0 ? "primary" : undefined} onClick={() => void api.send(s.id, r)}>{r}</Key>)}
                </div>
              )}
              <form className="mr-row" onSubmit={(e) => { e.preventDefault(); if (text.trim()) { void api.send(s.id, text.trim()); setText(""); } }}>
                <span className="mr-mono" style={{ padding: "2px 6px", background: "var(--mr-ink)", color: "var(--mr-tile)" }}>→</span>
                <input className="mr-input" placeholder={running ? "Steer it while it works (it reads this after its current step)" : "Tell it what to do next"} value={text} onChange={(e) => setText(e.target.value)} aria-label="Message this session" />
                <Key k="↵" onClick={() => { if (text.trim()) { void api.send(s.id, text.trim()); setText(""); } }}>Send</Key>
              </form>
            </div>
          )}
        </section>

        <aside style={{ flex: "1 1 300px", minWidth: 0, display: "flex", flexDirection: "column", gap: 12 }}>
          {/* Only what this session has: no empty plan box, no local change map for a PR review (J8). */}
          {s.todos.length > 0 && <div style={{ background: "var(--mr-tile)", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
            <h2 className="mr-h">Plan</h2>
            {s.todos.map((t, i) => (
              <div key={i} className="mr-row" style={{ color: t.status === "in_progress" ? "var(--mr-ink)" : t.status === "completed" ? "var(--mr-ink-3)" : "var(--mr-ink-2)", fontWeight: t.status === "in_progress" ? 700 : 400 }}>
                <span aria-hidden="true" style={{ width: 14 }}>{t.status === "completed" ? "✓" : t.status === "in_progress" ? "▸" : "·"}</span>
                <span>{t.status === "in_progress" && t.activeForm ? t.activeForm : t.content}</span>
              </div>
            ))}
            <Bar value={tile.progress} />
          </div>}
          {s.kind !== "review" && <ChangeMap s={s} />}
          <span className="mr-mono mr-dim" style={{ fontSize: 12 }}>{s.model ?? ""}{s.costUsd ? ` · $${s.costUsd.toFixed(2)} equiv.` : ""}</span>
        </aside>
      </main>
    </div>
  );
}

// The structured transcript (decision 13): readable rows, not terminal text. ⌘R shows raw JSON.
function Transcript({ items, raw, diagrams, onDiagram, onDiscover }: { items: TranscriptItem[]; raw: boolean; diagrams: Record<string, Diagram | null>; onDiagram: (t: { id: string; text: string }) => void; onDiscover: (what: string) => void }) {
  const end = useRef<HTMLDivElement>(null);
  const [drawing, setDrawing] = useState<Set<string>>(new Set());
  useEffect(() => { end.current?.scrollIntoView({ block: "nearest" }); }, [items.length]);
  if (items.length === 0) return <div className="mr-dim" style={{ padding: 12, background: "var(--mr-tile)" }}>Waiting for the first message…</div>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--mr-gap)" }}>
      {(raw ? items : groupTools(items.filter((t) => !(t.kind === "tool" && t.name === "TodoWrite")))).map((t) => raw ? (
        <pre key={t.id} className="mr-code" style={{ fontSize: 11 }}>{JSON.stringify(t, null, 1)}</pre>
      ) : t.kind === "text" ? (
        <div key={t.id} style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          {diagrams[t.id] && <FlowDiagram d={diagrams[t.id]!} />}
          <div style={{ position: "relative", padding: "12px 14px", background: "var(--mr-tile)", whiteSpace: "pre-wrap" }}>
            {t.text}
            {t.text.length >= 200 && !diagrams[t.id] && (
              <span style={{ position: "absolute", top: 6, right: 8 }}>
                <Key onClick={() => { setDrawing((d) => new Set(d).add(t.id)); onDiagram(t); }} disabled={drawing.has(t.id) && !(t.id in diagrams)}>
                  {drawing.has(t.id) && !(t.id in diagrams) ? "Drawing…" : t.id in diagrams ? "No flow to draw · retry" : "Diagram"}
                </Key>
              </span>
            )}
          </div>
        </div>
      ) : t.kind === "user" ? (
        <div key={t.id} className="mr-row" style={{ padding: "10px 14px", background: "var(--mr-well)" }}><span className="mr-mono mr-dim">you →</span><span>{t.text}</span></div>
      ) : t.kind === "result" ? (
        <div key={t.id} className="mr-row mr-mono" style={{ padding: "6px 14px", color: t.ok ? "var(--mr-done)" : "var(--mr-error)", fontSize: 12 }}>{t.ok ? "✓ turn finished" : "✕ turn failed"}</div>
      ) : t.kind === "tools" ? (
        <ToolGroup key={t.id} tools={t.tools} onDiscover={onDiscover} />
      ) : (
        <ToolRow key={t.id} t={t} onDiscover={onDiscover} />
      ))}
      <div ref={end} />
    </div>
  );
}

function ToolRow({ t, onDiscover }: { t: Extract<TranscriptItem, { kind: "tool" }>; onDiscover: (what: string) => void }) {
  const [open, setOpen] = useState(false);
  const detail = t.input.command ?? t.input.file_path ?? t.input.pattern ?? t.input.url ?? t.input.query ?? t.input.description ?? "";
  const result = t.result as Record<string, unknown> | string | undefined;
  const out = typeof result === "string" ? result : result ? String(result.stdout ?? result.content ?? JSON.stringify(result)) : "";
  const summary = summarizeTool(t.name, t.input);
  return (
    <div data-mr="ToolRow" data-mr-source={t.toolUseId} style={{ background: "var(--mr-tile)" }}>
      <button type="button" onClick={pointer({ open: () => setOpen((x) => !x), deeper: () => setOpen(true), discover: () => onDiscover(`the ${t.name} call ${JSON.stringify(t.input).slice(0, 300)}`) })} className="mr-row" style={{ width: "100%", padding: "8px 14px", border: 0, background: "transparent", color: "inherit", font: "inherit", textAlign: "left", cursor: "pointer" }}>
        <span className="mr-mono" style={{ fontWeight: 700, minWidth: 90 }}>{t.name.replace(/^mcp__/, "")}</span>
        <span className="mr-ink2 mr-grow mr-ellipsis" title={String(detail)}>{summary}</span>
        <span className="mr-mono" style={{ fontSize: 12, color: t.isError ? "var(--mr-error)" : t.result === undefined ? "var(--mr-ink-3)" : "var(--mr-done)" }}>{t.isError ? "✕" : t.result === undefined ? "…" : "✓"}</span>
      </button>
      {open && detail && String(detail) !== summary && <pre className="mr-code" style={{ margin: "0 14px 6px", whiteSpace: "pre-wrap", fontSize: 12 }}>{String(detail)}</pre>}
      {open && out && <pre className="mr-code" style={{ margin: "0 14px 10px", maxHeight: 260, overflow: "auto", fontSize: 12 }}>{out.slice(0, 4000)}</pre>}
    </div>
  );
}

// What to say next after a turn (F11): the choices its last question offers, or the usual next
// steps for finished work.
export function nextReplies(s: SessionState): string[] {
  const last = s.transcript.filter((t) => t.kind === "text" || t.kind === "user").at(-1);
  if (last?.kind === "text" && /\?\s*$/.test(last.text.trim())) {
    const opts = replyOptions(proseQuestion(last.text));
    if (opts.length) return opts;
  }
  if (last?.kind !== "text") return [];
  return Object.keys(s.files).length
    ? ["Open a PR for this", "Run the full test suite", "Explain the changes and their risks"]
    : ["Continue", "Explain what you found"];
}

type Tool = Extract<TranscriptItem, { kind: "tool" }>;
type Row = TranscriptItem | { kind: "tools"; id: string; tools: Tool[] };

// Three or more tool calls in a row fold into one summary line (F8): "Read 2 files · Edited 1 file · Ran 1 command".
function groupTools(items: TranscriptItem[]): Row[] {
  const out: Row[] = [];
  let run: Tool[] = [];
  const flush = () => {
    if (run.length >= 3) out.push({ kind: "tools", id: `g:${run[0].id}`, tools: run });
    else out.push(...run);
    run = [];
  };
  for (const t of items) {
    if (t.kind === "tool") run.push(t);
    else { flush(); out.push(t); }
  }
  flush();
  return out;
}

const VERB: Record<string, [string, string]> = { Read: ["Read", "file"], Edit: ["Edited", "file"], MultiEdit: ["Edited", "file"], Write: ["Wrote", "file"], Bash: ["Ran", "command"], Grep: ["Searched", "time"], Glob: ["Listed", "pattern"], WebFetch: ["Fetched", "page"], WebSearch: ["Searched the web", "time"] };

function summarise(tools: Tool[]): string {
  const counts = new Map<string, number>();
  for (const t of tools) { const v = VERB[t.name]; const key = v ? `${v[0]}|${v[1]}` : `Used ${t.name.replace(/^mcp__\w+__/, "")}|time`; counts.set(key, (counts.get(key) ?? 0) + 1); }
  return [...counts].map(([k, n]) => { const [verb, noun] = k.split("|"); return `${verb} ${n} ${noun}${n === 1 ? "" : "s"}`; }).join(" · ");
}

function ToolGroup({ tools, onDiscover }: { tools: Tool[]; onDiscover: (what: string) => void }) {
  const [open, setOpen] = useState(false);
  const failed = tools.some((t) => t.isError);
  const pending = tools.some((t) => t.result === undefined);
  return (
    <div data-mr="ToolGroup" data-mr-source={tools[0].toolUseId} style={{ background: "var(--mr-tile)" }}>
      <button type="button" onClick={() => setOpen((x) => !x)} className="mr-row" style={{ width: "100%", padding: "8px 14px", border: 0, background: "transparent", color: "inherit", font: "inherit", textAlign: "left", cursor: "pointer" }}>
        <span className="mr-mono" style={{ fontWeight: 700, minWidth: 90 }}>{tools.length} steps</span>
        <span className="mr-ink2 mr-grow mr-ellipsis">{summarise(tools)}</span>
        <span className="mr-mono" style={{ fontSize: 12, color: failed ? "var(--mr-error)" : pending ? "var(--mr-ink-3)" : "var(--mr-done)" }}>{failed ? "✕" : pending ? "…" : "✓"} {open ? "▾" : "▸"}</span>
      </button>
      {open && <div style={{ display: "flex", flexDirection: "column", gap: 1, padding: "0 0 6px 24px" }}>{tools.map((t) => <ToolRow key={t.id} t={t} onDiscover={onDiscover} />)}</div>}
    </div>
  );
}
