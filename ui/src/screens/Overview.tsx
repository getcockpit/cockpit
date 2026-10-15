import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { keyLabel } from "../platform";
import { StateMark } from "../components";
import type { Doc } from "../state/docs";
import type { AppState } from "../state/types";
import { bounds, COL_W, BLOCK_GAP, BLOCK_H, detail, fit, GROUP_LABEL, GROUPS, HEADER_H, LABEL_H, overview, PAD, zoomAt, type Layout, type OverviewArea, type OverviewBlock } from "../state/overview";

// The Overview (decision 40, MR-155): a Miro-like canvas with one rectangle per workspace and every
// open session and doc as its own block. Scroll pans, pinch or ⌘-scroll zooms around the cursor,
// ⌘0 fits everything. Drag a header to arrange. Read-only: a click goes into the workspace or item.

type Cam = { x: number; y: number; zoom: number };
// Where you left the canvas, so coming back from a workspace is a return (null: fit on first open).
let lastCam: Cam | null = null;

const LAMP: Record<string, string> = { needs_you: "var(--mr-needs)", error: "var(--mr-error)", review: "var(--mr-ink)", working: "var(--mr-ink-3)", almost: "var(--mr-ink-3)", starting: "var(--mr-ink-3)" };

export function Overview({ state, docs, fitSignal, onOpenWorkspace, onOpenSession, onOpenDoc }: { state: AppState; docs: Doc[]; fitSignal: number; onOpenWorkspace: (ws: string) => void; onOpenSession: (ws: string, id: string) => void; onOpenDoc: (ws: string, id: string) => void }) {
  const view = useRef<HTMLDivElement>(null);
  const [cam, setCamNow] = useState<Cam>(lastCam ?? { x: 0, y: 0, zoom: 1 });
  const setCam = (c: Cam | ((c: Cam) => Cam)) => setCamNow((prev) => (lastCam = typeof c === "function" ? c(prev) : c));
  // Positions while a drag is in flight, and until its event replays back into the layout.
  const [held, setHeld] = useState<Layout>({});
  useEffect(() => setHeld({}), [state.overviewLayout]);
  const areas = useMemo(() => overview(state, docs, { ...state.overviewLayout, ...held }), [state, docs, held]);
  const fitAll = () => { const r = view.current?.getBoundingClientRect(); if (r) setCam(fit(bounds(areas), { w: r.width, h: r.height })); };
  useLayoutEffect(() => { if (!lastCam || fitSignal) fitAll(); }, [fitSignal]);

  // Wheel: pan in any direction; pinch (ctrl+wheel in Chromium) or ⌘-scroll zooms. WebKit's trackpad
  // pinch arrives as gesture events instead. Native listeners: React's wheel handler is passive.
  useEffect(() => {
    const el = view.current;
    if (!el) return;
    const at = (e: { clientX: number; clientY: number }) => { const r = el.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] as const; };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) { const [px, py] = at(e); setCam((c) => zoomAt(c, px, py, Math.exp(-e.deltaY * 0.01))); }
      else setCam((c) => ({ ...c, x: c.x - e.deltaX, y: c.y - e.deltaY }));
    };
    let scale = 1;
    const gStart = (e: Event) => { e.preventDefault(); scale = 1; };
    const gChange = (e: Event) => {
      e.preventDefault();
      const g = e as Event & { scale: number; clientX: number; clientY: number };
      const [px, py] = at(g);
      setCam((c) => zoomAt(c, px, py, g.scale / scale));
      scale = g.scale;
    };
    el.addEventListener("wheel", wheel, { passive: false });
    el.addEventListener("gesturestart", gStart);
    el.addEventListener("gesturechange", gChange);
    return () => { el.removeEventListener("wheel", wheel); el.removeEventListener("gesturestart", gStart); el.removeEventListener("gesturechange", gChange); };
  }, []);

  // Pointer drags: on the empty canvas they pan; on a workspace header they move that rectangle.
  const drag = useRef<{ kind: "pan" | "move"; ws?: string; x0: number; y0: number; ox: number; oy: number; moved: boolean; frozen?: Layout } | null>(null);
  const suppressClick = useRef(false);
  const down = (e: React.PointerEvent, ws?: string) => {
    if (e.button !== 0) return;
    if (!ws && e.target !== e.currentTarget) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const a = ws ? areas.find((x) => x.workspace === ws) : null;
    // Freeze every rectangle where it is, so moving one doesn't shuffle the ones still auto-placed.
    const frozen = ws ? Object.fromEntries(areas.map((x) => [x.workspace, { x: x.x, y: x.y }])) : undefined;
    drag.current = { kind: ws ? "move" : "pan", ws, x0: e.clientX, y0: e.clientY, ox: a ? a.x : cam.x, oy: a ? a.y : cam.y, moved: false, frozen };
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x0, dy = e.clientY - d.y0;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    if (d.kind === "pan") setCam((c) => ({ ...c, x: d.ox + dx, y: d.oy + dy }));
    else if (d.ws) setHeld({ ...d.frozen, [d.ws]: { x: d.ox + dx / cam.zoom, y: d.oy + dy / cam.zoom } });
  };
  const up = () => {
    const d = drag.current;
    drag.current = null;
    if (!d?.moved || d.kind !== "move" || !d.ws) return;
    suppressClick.current = true;
    // The moved one, plus any still auto-placed: their spots are now fixed too, so nothing jumps later.
    for (const a of areas) if (a.workspace === d.ws || !state.overviewLayout[a.workspace]) void invoke("overview_move", { workspace: a.workspace, x: a.x, y: a.y }).catch(() => {});
  };
  const click = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); if (suppressClick.current) { suppressClick.current = false; return; } fn(); };

  const level = detail(cam.zoom);
  const moving = drag.current?.kind === "move" ? drag.current.ws : null;
  return (
    <div ref={view} data-mr="OverviewCanvas" data-mr-source="overview" data-zoom={level} onPointerDown={(e) => down(e)} onPointerMove={move} onPointerUp={up} onPointerCancel={() => (drag.current = null)}
      style={{ position: "relative", height: "100%", overflow: "hidden", background: "var(--mr-base)", touchAction: "none", cursor: drag.current?.kind === "pan" ? "grabbing" : "default" }}>
      <div style={{ position: "absolute", left: 0, top: 0, transformOrigin: "0 0", transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.zoom})`, pointerEvents: "none" }}>
        {areas.map((a) => <Area key={a.workspace} a={a} level={level} zoom={cam.zoom} lifted={moving === a.workspace}
          onDown={(e) => down(e, a.workspace)} onMove={move} onUp={up}
          onOpen={click(() => onOpenWorkspace(a.workspace))}
          onBlock={(b) => click(() => (b.kind === "session" ? onOpenSession(a.workspace, b.id) : onOpenDoc(a.workspace, b.id)))} />)}
      </div>
      <div className="mr-row mr-dim" data-mr="OverviewHint" style={{ position: "absolute", left: 12, bottom: 10, gap: 12, fontSize: 12, pointerEvents: "none" }}>
        <span>Scroll to pan · pinch or {keyLabel("⌘")}-scroll to zoom · drag a header to arrange</span>
      </div>
      <div className="mr-row" style={{ position: "absolute", right: 12, bottom: 8, gap: 4 }}>
        <button type="button" className="mr-key" aria-label="Zoom out" onClick={() => { const r = view.current!.getBoundingClientRect(); setCam((c) => zoomAt(c, r.width / 2, r.height / 2, 1 / 1.25)); }}>−</button>
        <span className="mr-mono mr-dim" style={{ minWidth: 44, textAlign: "center", fontSize: 12 }}>{Math.round(cam.zoom * 100)}%</span>
        <button type="button" className="mr-key" aria-label="Zoom in" onClick={() => { const r = view.current!.getBoundingClientRect(); setCam((c) => zoomAt(c, r.width / 2, r.height / 2, 1.25)); }}>+</button>
        <button type="button" className="mr-key" onClick={fitAll}><kbd>{keyLabel("⌘0")}</kbd>Fit all</button>
      </div>
    </div>
  );
}

/** The count labels beside a workspace's name: zero counts hidden, needs you in amber. */
export function countLabels(c: OverviewArea["counts"]): { key: string; text: string; needs?: boolean }[] {
  return [
    { key: "needs", text: `⚠ ${c.needs} need${c.needs === 1 ? "s" : ""} you`, n: c.needs, needs: true },
    { key: "resume", text: `↻ ${c.resume} resume`, n: c.resume },
    { key: "progress", text: `▶ ${c.progress} in progress`, n: c.progress },
    { key: "review", text: `◇ ${c.review} review`, n: c.review },
  ].filter((x) => x.n > 0).map(({ n: _, ...x }) => x);
}

function Area({ a, level, zoom, lifted, onDown, onMove, onUp, onOpen, onBlock }: { a: OverviewArea; level: "far" | "middle" | "close"; zoom: number; lifted: boolean; onDown: (e: React.PointerEvent) => void; onMove: (e: React.PointerEvent) => void; onUp: () => void; onOpen: (e: React.MouseEvent) => void; onBlock: (b: OverviewBlock) => (e: React.MouseEvent) => void }) {
  const labels = countLabels(a.counts);
  const empty = GROUPS.every((g) => !a.groups[g].length);
  // Far out the header grows against the zoom, so names and counts stay readable over the whole rectangle.
  const far = level === "far";
  const k = far ? Math.min(1 / zoom, 3) : 1;
  return (
    <div data-mr="OverviewArea" data-mr-source={a.workspace} data-mr-name={a.name} onClick={onOpen}
      style={{ position: "absolute", left: a.x, top: a.y, width: a.w, height: a.h, overflow: "hidden", background: "var(--mr-band)", pointerEvents: "auto", cursor: "pointer", boxShadow: a.counts.needs ? "inset 4px 0 0 var(--mr-needs)" : undefined, outline: lifted ? "3px solid var(--mr-selected)" : undefined, zIndex: lifted ? 1 : undefined }}>
      <button type="button" data-mr="OverviewHeader" data-mr-source={a.workspace} aria-label={`Open workspace ${a.name}`} onClick={onOpen}
        onPointerDown={(e) => { e.stopPropagation(); onDown(e); }} onPointerMove={onMove} onPointerUp={onUp}
        className="mr-row" style={{ width: "100%", height: far ? "100%" : HEADER_H, alignItems: far ? "flex-start" : "center", flexWrap: "wrap", alignContent: far ? "flex-start" : undefined, gap: 10 * k, padding: `${12 * Math.min(k, 3)}px ${PAD}px`, border: 0, background: "transparent", font: "inherit", textAlign: "left", cursor: "grab", touchAction: "none", color: "var(--mr-ink)" }}
        title={`${a.folder ? `Starts in ${a.folder}\n` : ""}Click to open · drag to arrange`}>
        <strong style={{ fontSize: 20 * k }}>{a.name}</strong>
        {labels.map((l) => (
          <span key={l.key} data-mr="OverviewCount" data-mr-source={`${a.workspace}:${l.key}`} className="mr-mono"
            style={{ fontSize: 13 * k, fontWeight: 700, padding: `0 ${6 * k}px`, background: l.needs ? "var(--mr-needs)" : undefined, color: l.needs ? "var(--mr-ink)" : "var(--mr-ink-2)" }}>{l.text}</span>
        ))}
        {!far && <span className="mr-grow" />}
        {!far && a.index < 9 && <kbd className="mr-mono mr-dim" style={{ fontSize: 11 }}>{keyLabel(`⌘${a.index + 1}`)}</kbd>}
      </button>
      {!far && (empty
        ? <span className="mr-dim" style={{ position: "absolute", left: PAD, top: HEADER_H }}>Nothing open</span>
        : GROUPS.map((g, i) => (
          <div key={g} data-mr="OverviewGroup" data-mr-source={`${a.workspace}:${g}`} style={{ position: "absolute", left: PAD + i * (COL_W + BLOCK_GAP), top: HEADER_H, width: COL_W, display: "flex", flexDirection: "column", gap: BLOCK_GAP }}>
            <span className="mr-dim" style={{ height: LABEL_H - BLOCK_GAP, fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" }}>{GROUP_LABEL[g]}{a.groups[g].length ? ` · ${a.groups[g].length}` : ""}</span>
            {a.groups[g].map((b) => <Block key={`${b.kind}:${b.id}`} b={b} close={level === "close"} onClick={onBlock(b)} />)}
          </div>
        )))}
    </div>
  );
}

function Block({ b, close, onClick }: { b: OverviewBlock; close: boolean; onClick: (e: React.MouseEvent) => void }) {
  return (
    <button type="button" data-mr="OverviewBlock" data-mr-source={b.id} data-mr-kind={b.kind} data-s={b.lamp} aria-label={`Open ${b.title}`} onClick={onClick} onPointerDown={(e) => e.stopPropagation()}
      style={{ height: BLOCK_H, display: "flex", gap: 8, padding: "8px 10px 8px 0", border: 0, font: "inherit", textAlign: "left", cursor: "pointer", background: "var(--mr-tile)", color: "var(--mr-ink)", overflow: "hidden" }}>
      <span aria-hidden="true" style={{ flex: "none", width: 4, alignSelf: "stretch", background: LAMP[b.lamp] ?? "var(--mr-lamp-off)" }} />
      <span style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        <span className="mr-ellipsis" style={{ fontWeight: 600 }}>{b.kind === "doc" && <span className="mr-mono mr-dim" style={{ fontWeight: 400, fontSize: 12 }}>doc · </span>}{b.title}</span>
        {close
          ? <>
              <span className="mr-ellipsis" style={{ fontSize: 12 }}>{b.kind === "session" ? <StateMark s={b.lamp} /> : null} <span className="mr-ink2">{b.status}</span></span>
              {b.step && b.step !== b.status && <span className="mr-ellipsis mr-dim" style={{ fontSize: 12 }}>{b.step}</span>}
            </>
          : null}
      </span>
    </button>
  );
}
