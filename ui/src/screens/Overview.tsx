import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { keyLabel } from "../platform";
import { StateMark } from "../components";
import type { Doc } from "../state/docs";
import type { AppState } from "../state/types";
import { bounds, COL_W, BLOCK_GAP, BLOCK_H, detail, fit, GROUP_LABEL, GROUPS, HEADER_H, LABEL_H, MAX_ZOOM, MIN_ZOOM, overview, PAD, readable, settle, shown, zoomAt, type Layout, type OverviewArea, type OverviewBlock } from "../state/overview";
import { overviewKey } from "../components/keys";

// The Overview (decision 40, MR-155): a Miro-like canvas with one rectangle per workspace and every
// open session and doc as its own block. Scroll pans, pinch or ⌘-scroll zooms around the cursor,
// ⌘0 fits everything, + / − and arrows work too. Drag a workspace to arrange. Read-only: a click goes
// into the workspace or item. Zoomed out, text grows against the zoom so it stays readable.

type Cam = { x: number; y: number; zoom: number };
// Where you left the canvas, so coming back from a workspace is a return (null: fit on first open).
let lastCam: Cam | null = null;
// Until you pan or zoom yourself, the camera keeps everything in view as the window and the map change.
let following = true;
const BAR_H = 44; // the hint and zoom buttons along the bottom

const LAMP: Record<string, string> = { needs_you: "var(--mr-needs)", error: "var(--mr-error)", review: "var(--mr-ink)", working: "var(--mr-ink-3)", almost: "var(--mr-ink-3)", starting: "var(--mr-ink-3)" };
// Stopped work waiting for a resume reads as an empty lamp: nothing is running there.
// On a block's thin edge that's a dashed bar; on the far view's squares, a hollow one.
const lampStyle = (s: string, bar = false): React.CSSProperties => (s !== "interrupted" ? { background: LAMP[s] ?? "var(--mr-lamp-off)" }
  : bar ? { background: "repeating-linear-gradient(var(--mr-ink-2) 0 6px, transparent 6px 10px)" } : { boxShadow: "inset 0 0 0 2px var(--mr-ink-2)" });

export function Overview({ state, docs, fitSignal, onBack, onOpenWorkspace, onOpenSession, onOpenDoc }: { state: AppState; docs: Doc[]; fitSignal: number; onBack: () => void; onOpenWorkspace: (ws: string) => void; onOpenSession: (ws: string, id: string) => void; onOpenDoc: (ws: string, id: string) => void }) {
  const view = useRef<HTMLDivElement>(null);
  const [cam, setCamNow] = useState<Cam>(lastCam ?? { x: 0, y: 0, zoom: 1 });
  const setCam = (c: Cam | ((c: Cam) => Cam)) => setCamNow((prev) => (lastCam = typeof c === "function" ? c(prev) : c));
  // Buttons and keys glide the camera; wheel and drags follow the hand with no lag.
  const [glide, setGlide] = useState(false);
  const glideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const glideTo = (c: Cam | ((c: Cam) => Cam)) => { setGlide(true); clearTimeout(glideTimer.current); glideTimer.current = setTimeout(() => setGlide(false), 260); setCam(c); };
  const byHand = (c: Cam | ((c: Cam) => Cam)) => { following = false; setGlide(false); setCam(c); };
  // The viewport, so the auto layout packs to its shape and fit-all follows a resize.
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = view.current;
    if (!el) return;
    const measure = () => { const r = el.getBoundingClientRect(); setSize((s) => (s.w === r.width && s.h === r.height ? s : { w: r.width, h: r.height })); };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Positions while a drag is in flight, and until its event replays back into the layout.
  const [held, setHeld] = useState<Layout>({});
  useEffect(() => setHeld({}), [state.overviewLayout]);
  const aspect = size.w && size.h ? size.w / size.h : undefined;
  const areas = useMemo(() => overview(state, docs, { ...state.overviewLayout, ...held }, aspect), [state, docs, held, aspect]);
  // Fit into the part of the canvas above the zoom bar, so nothing starts hidden under it.
  const fitNow = (smooth: boolean) => { if (!size.w) return; following = true; (smooth ? glideTo : setCam)(fit(bounds(areas), { w: size.w, h: Math.max(1, size.h - BAR_H) })); };
  const fitAll = () => fitNow(true);
  const box = bounds(areas);
  const boxKey = `${box.x},${box.y},${box.w},${box.h}`;
  useLayoutEffect(() => { if (size.w && (!lastCam || fitSignal)) fitNow(!!lastCam); }, [fitSignal, size.w > 0]);
  // While it follows, keep it fitted; not while a rectangle is being dragged (the camera would chase it).
  useLayoutEffect(() => { if (following && size.w && !drag.current) fitNow(false); }, [size.w, size.h, boxKey]);
  // Far out a click zooms into that workspace (close enough to read it) instead of leaving the map.
  const zoomTo = (a: OverviewArea) => { following = false; glideTo(fit(a, { w: size.w, h: Math.max(1, size.h - BAR_H) })); };
  const zoomBy = (by: number) => { following = false; glideTo((c) => zoomAt(c, size.w / 2, size.h / 2, by)); };

  // Wheel: pan in any direction; pinch (ctrl+wheel in Chromium) or ⌘-scroll zooms. WebKit's trackpad
  // pinch arrives as gesture events instead. Native listeners: React's wheel handler is passive.
  useEffect(() => {
    const el = view.current;
    if (!el) return;
    const at = (e: { clientX: number; clientY: number }) => { const r = el.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] as const; };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) { const [px, py] = at(e); byHand((c) => zoomAt(c, px, py, Math.exp(-e.deltaY * 0.01))); }
      else byHand((c) => ({ ...c, x: c.x - e.deltaX, y: c.y - e.deltaY }));
    };
    let scale = 1;
    const gStart = (e: Event) => { e.preventDefault(); scale = 1; };
    const gChange = (e: Event) => {
      e.preventDefault();
      const g = e as Event & { scale: number; clientX: number; clientY: number };
      const [px, py] = at(g);
      byHand((c) => zoomAt(c, px, py, g.scale / scale));
      scale = g.scale;
    };
    el.addEventListener("wheel", wheel, { passive: false });
    el.addEventListener("gesturestart", gStart);
    el.addEventListener("gesturechange", gChange);
    return () => { el.removeEventListener("wheel", wheel); el.removeEventListener("gesturestart", gStart); el.removeEventListener("gesturechange", gChange); };
  }, []);

  // + / − zoom around the middle, arrows pan.
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e) => {
    const k = overviewKey(e, { dialog: !!document.querySelector('[role="dialog"]') });
    if (!k) return;
    e.preventDefault();
    if (k.do === "back") onBack();
    else if (k.do === "zoom") zoomBy(k.by);
    else { following = false; glideTo((c) => ({ ...c, x: c.x + k.dx, y: c.y + k.dy })); }
  };
  useEffect(() => { const on = (e: KeyboardEvent) => keyRef.current(e); window.addEventListener("keydown", on); return () => window.removeEventListener("keydown", on); }, []);

  // Pointer drags: on the empty canvas they pan; anywhere on a workspace (but its blocks) they move it.
  const drag = useRef<{ kind: "pan" | "move"; ws?: string; x0: number; y0: number; ox: number; oy: number; moved: boolean; frozen?: Layout } | null>(null);
  const suppressClick = useRef(false);
  const down = (e: React.PointerEvent, ws?: string) => {
    if (e.button !== 0) return;
    if (!ws && e.target !== e.currentTarget) return;
    if (ws) e.stopPropagation();
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
    if (d.kind === "pan") byHand((c) => ({ ...c, x: d.ox + dx, y: d.oy + dy }));
    else if (d.ws) { following = false; setHeld({ ...d.frozen, [d.ws]: { x: d.ox + dx / cam.zoom, y: d.oy + dy / cam.zoom } }); }
  };
  const [, rerender] = useState(0);
  const up = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    rerender((n) => n + 1); // the grab cursor and the lifted outline go with the drag
    if (!d.moved) return;
    // The click that ends a drag isn't a click; let the next real one through even if none comes.
    suppressClick.current = true;
    setTimeout(() => (suppressClick.current = false), 0);
    if (d.kind !== "move" || !d.ws) return;
    // It never lands on top of another workspace: nudged to the nearest free spot beside it.
    const moved = areas.find((a) => a.workspace === d.ws);
    const spot = moved ? settle(moved, areas.filter((a) => a.workspace !== d.ws), { x: -cam.x / cam.zoom, y: -cam.y / cam.zoom, w: size.w / cam.zoom, h: size.h / cam.zoom }) : null;
    if (moved && spot) setHeld((h) => ({ ...h, [moved.workspace]: spot }));
    // The moved one, plus any still auto-placed: their spots are now fixed too, so nothing jumps later.
    for (const a of areas) if (a.workspace === d.ws || !state.overviewLayout[a.workspace]) void invoke("overview_move", { workspace: a.workspace, ...(a.workspace === d.ws && spot ? spot : { x: a.x, y: a.y }) }).catch(() => {});
  };
  const click = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); if (suppressClick.current) { suppressClick.current = false; return; } fn(); };
  // Double-click the empty canvas to zoom in there.
  const dbl = (e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return;
    const r = view.current!.getBoundingClientRect();
    following = false;
    glideTo((c) => zoomAt(c, e.clientX - r.left, e.clientY - r.top, 2));
  };

  // Tabbing to a block or workspace off screen brings it into view. The browser would scroll the
  // clipped canvas itself instead, and the camera would no longer match what's drawn: undo that, pan.
  const focused = (e: React.FocusEvent) => {
    const el = view.current;
    if (!el) return;
    el.scrollLeft = 0; el.scrollTop = 0;
    // Only keyboard focus: a click on a half-hidden block must land on it, not chase a moving camera.
    if (!(e.target as HTMLElement).matches(":focus-visible")) return;
    const v = el.getBoundingClientRect(), r = (e.target as HTMLElement).getBoundingClientRect(), m = 24, mb = 64; // the zoom bar sits along the bottom
    const dx = r.left < v.left + m ? v.left + m - r.left : r.right > v.right - m ? Math.max(v.right - m - r.right, v.left + m - r.left) : 0;
    const dy = r.top < v.top + m ? v.top + m - r.top : r.bottom > v.bottom - mb ? Math.max(v.bottom - mb - r.bottom, v.top + m - r.top) : 0;
    if (dx || dy) { following = false; glideTo((c) => ({ ...c, x: c.x + dx, y: c.y + dy })); }
  };

  const level = detail(cam.zoom);
  const moving = drag.current?.kind === "move" ? drag.current.ws : null;
  return (
    <div ref={view} data-mr="OverviewCanvas" data-mr-source="overview" data-zoom={level} onPointerDown={(e) => down(e)} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onLostPointerCapture={up} onDoubleClick={dbl} onFocus={focused}
      style={{ position: "relative", height: "100%", overflow: "hidden", background: "var(--mr-base)", touchAction: "none", cursor: drag.current?.kind === "pan" ? "grabbing" : "default" }}>
      <div className="mr-ov-cam" data-glide={glide || undefined} style={{ position: "absolute", left: 0, top: 0, transformOrigin: "0 0", transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.zoom})`, pointerEvents: "none" }}>
        {areas.map((a) => <Area key={a.workspace} a={a} level={level} zoom={cam.zoom} lifted={moving === a.workspace}
          onDown={(e) => down(e, a.workspace)}
          onOpen={click(() => onOpenWorkspace(a.workspace))}
          onZoomTo={click(() => zoomTo(a))}
          onBlock={(b) => click(() => (b.kind === "session" ? onOpenSession(a.workspace, b.id) : onOpenDoc(a.workspace, b.id)))} />)}
      </div>
      <div className="mr-row mr-dim" data-mr="OverviewHint" style={{ position: "absolute", left: 12, bottom: 10, right: 280, fontSize: 12, pointerEvents: "none", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        <span>Scroll or drag to pan · pinch, {keyLabel("⌘")}-scroll or +/− to zoom · drag a workspace to move it</span>
      </div>
      <div className="mr-row" data-mr="OverviewZoom" style={{ position: "absolute", right: 12, bottom: 8, gap: 4 }}>
        <button type="button" className="mr-key" aria-label="Zoom out" title="Zoom out (−)" disabled={cam.zoom <= MIN_ZOOM + 1e-6} onClick={() => zoomBy(1 / 1.25)}>−</button>
        <button type="button" className="mr-mono mr-dim" data-mr="OverviewZoomLevel" aria-label="Zoom to 100%" title="Zoom to 100%" onClick={() => zoomBy(1 / cam.zoom)}
          style={{ minWidth: 48, minHeight: 36, textAlign: "center", fontSize: 12, border: 0, background: "transparent", cursor: "pointer", color: "inherit" }}>{Math.round(cam.zoom * 100)}%</button>
        <button type="button" className="mr-key" aria-label="Zoom in" title="Zoom in (+)" disabled={cam.zoom >= MAX_ZOOM - 1e-6} onClick={() => zoomBy(1.25)}>+</button>
        <button type="button" className="mr-key" onClick={fitAll}><kbd>{keyLabel("⌘0")}</kbd>Fit all</button>
      </div>
    </div>
  );
}

/** The count labels beside a workspace's name: zero counts hidden, needs you in amber. `short` drops the
 *  words (zoomed out, where the column headings already say them). */
export function countLabels(c: OverviewArea["counts"], short = false): { key: string; text: string; title: string; needs?: boolean }[] {
  return [
    { key: "needs", icon: "⚠", word: c.needs === 1 ? "needs you" : "need you", n: c.needs, needs: true },
    { key: "resume", icon: "↻", word: "resume", n: c.resume },
    { key: "progress", icon: "▶", word: "in progress", n: c.progress },
    { key: "review", icon: "◇", word: "review", n: c.review },
  ].filter((x) => x.n > 0).map(({ key, icon, word, n, needs }) => ({ key, needs, title: `${n} ${word}`, text: short && !needs ? `${icon} ${n}` : `${icon} ${n} ${word}` }));
}

/** Every block's lamp in reading order, for the far view's strip: what needs you first. */
export const lamps = (a: OverviewArea): OverviewBlock[] => GROUPS.flatMap((g) => a.groups[g]).sort((x, y) => Number(y.needs) - Number(x.needs));

type AreaProps = { a: OverviewArea; level: "far" | "middle" | "close"; zoom: number; lifted: boolean; onDown: (e: React.PointerEvent) => void; onOpen: (e: React.MouseEvent) => void; onZoomTo: (e: React.MouseEvent) => void; onBlock: (b: OverviewBlock) => (e: React.MouseEvent) => void };

function Area({ a, level, zoom, lifted, onDown, onOpen, onZoomTo, onBlock }: AreaProps) {
  const empty = GROUPS.every((g) => !a.groups[g].length);
  const far = level === "far", close = level === "close";
  const labels = countLabels(a.counts, !close);
  const nameSize = readable(20, zoom, 14);
  const countSize = readable(13, zoom, 11);
  return (
    <div data-mr="OverviewArea" data-mr-source={a.workspace} data-mr-name={a.name} data-needs={a.counts.needs ? "" : undefined} className="mr-ov-area" onClick={far ? onZoomTo : onOpen} onPointerDown={onDown}
      title={`${a.name}${a.folder ? ` · starts in ${a.folder}` : ""}\n${far ? "Click to zoom in" : "Click to open"} · drag to move`}
      style={{ position: "absolute", left: a.x, top: a.y, width: a.w, height: a.h, overflow: "hidden", background: "var(--mr-band)", pointerEvents: "auto", cursor: lifted ? "grabbing" : "pointer", touchAction: "none", boxShadow: a.counts.needs ? "inset 4px 0 0 var(--mr-needs)" : undefined, outline: lifted ? `${3 / zoom}px solid var(--mr-selected)` : undefined, zIndex: lifted ? 1 : undefined }}>
      {far ? <Far a={a} zoom={zoom} onOpen={onZoomTo} /> : <>
        <button type="button" data-mr="OverviewHeader" data-mr-source={a.workspace} aria-label={`Open workspace ${a.name}`} onClick={onOpen}
          className="mr-row" style={{ width: "100%", height: HEADER_H, alignItems: "center", gap: 10, padding: `0 ${PAD}px`, border: 0, background: "transparent", font: "inherit", textAlign: "left", cursor: "inherit", color: "var(--mr-ink)", overflow: "hidden" }}>
          <strong className="mr-ellipsis" style={{ fontSize: nameSize, lineHeight: 1.1, minWidth: 0, flexShrink: 1 }}>{a.name}</strong>
          {labels.map((l) => (
            <span key={l.key} data-mr="OverviewCount" data-mr-source={`${a.workspace}:${l.key}`} className="mr-mono" title={l.title}
              style={{ flex: "none", fontSize: countSize, fontWeight: 700, padding: "0 6px", background: l.needs ? "var(--mr-needs)" : undefined, color: l.needs ? "var(--mr-ink)" : "var(--mr-ink-2)" }}>{l.text}</span>
          ))}
          <span className="mr-grow" />
          {close && a.index < 9 && <kbd className="mr-mono mr-dim" style={{ fontSize: 11 }}>{keyLabel(`⌘${a.index + 1}`)}</kbd>}
        </button>
        {empty
          ? <span className="mr-dim" style={{ position: "absolute", left: PAD, top: HEADER_H, fontSize: readable(14, zoom, 12) }}>Nothing open</span>
          : GROUPS.map((g, i) => (
            <div key={g} data-mr="OverviewGroup" data-mr-source={`${a.workspace}:${g}`} style={{ position: "absolute", left: PAD + i * (COL_W + BLOCK_GAP), top: HEADER_H, width: COL_W, display: "flex", flexDirection: "column", gap: BLOCK_GAP }}>
              <span className="mr-dim mr-ellipsis" style={{ height: LABEL_H - BLOCK_GAP, fontSize: Math.min(readable(12, zoom, 10), LABEL_H - BLOCK_GAP), lineHeight: 1, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" }}>{GROUP_LABEL[g]}{a.groups[g].length ? ` · ${a.groups[g].length}` : ""}</span>
              {a.groups[g].length
                ? (() => { const v = shown(a.groups[g]); return <>
                    {v.blocks.map((b) => <Block key={`${b.kind}:${b.id}`} b={b} close={close} zoom={zoom} onClick={onBlock(b)} />)}
                    {v.more > 0 && <button type="button" className="mr-ov-block" data-mr="OverviewMore" data-mr-source={`${a.workspace}:${g}`} onClick={onOpen} onPointerDown={(e) => e.stopPropagation()}
                      aria-label={`${v.more} more in ${GROUP_LABEL[g]}: open workspace ${a.name}`}
                      style={{ height: BLOCK_H, border: 0, font: "inherit", fontWeight: 600, fontSize: readable(14, zoom, 12), cursor: "pointer", background: "var(--mr-well)", color: "var(--mr-ink-2)" }}>+{v.more} more</button>}
                  </>; })()
                : <span aria-hidden="true" style={{ height: BLOCK_H, boxShadow: "inset 0 0 0 1px var(--mr-well)" }} />}
            </div>
          ))}
      </>}
    </div>
  );
}

/** Far out: the name, what needs you, and one lamp per open item, sized to stay legible over the rectangle. */
function Far({ a, zoom, onOpen }: { a: OverviewArea; zoom: number; onOpen: (e: React.MouseEvent) => void }) {
  const name = Math.min(readable(20, zoom, 14, 8), a.h * 0.32);
  const lamp = Math.min(10 / zoom, a.h * 0.16);
  const pad = Math.min(12 / zoom, a.h * 0.1);
  const all = lamps(a);
  return (
    <button type="button" data-mr="OverviewHeader" data-mr-source={a.workspace} aria-label={`Zoom to workspace ${a.name}`} onClick={onOpen}
      style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", alignItems: "flex-start", gap: lamp * 0.6, padding: pad, border: 0, background: "transparent", font: "inherit", textAlign: "left", cursor: "inherit", color: "var(--mr-ink)", overflow: "hidden" }}>
      <span className="mr-row" style={{ gap: name * 0.4, maxWidth: "100%", alignItems: "center" }}>
        <strong className="mr-ellipsis" style={{ fontSize: name, lineHeight: 1.1, minWidth: 0 }}>{a.name}</strong>
        {a.counts.needs > 0 && <span data-mr="OverviewCount" data-mr-source={`${a.workspace}:needs`} className="mr-mono" title={`${a.counts.needs} need${a.counts.needs === 1 ? "s" : ""} you`}
          style={{ flex: "none", fontSize: name * 0.75, fontWeight: 700, padding: `0 ${name * 0.25}px`, background: "var(--mr-needs)" }}>⚠ {a.counts.needs}</span>}
      </span>
      {all.length
        ? <span data-mr="OverviewLamps" data-mr-source={a.workspace} style={{ display: "flex", flexWrap: "wrap", gap: lamp * 0.4 }}>
            {all.map((b) => <span key={`${b.kind}:${b.id}`} data-s={b.lamp} style={{ width: lamp, height: lamp, ...lampStyle(b.lamp) }} />)}
          </span>
        : <span className="mr-dim" style={{ fontSize: name * 0.6 }}>Nothing open</span>}
    </button>
  );
}

function Block({ b, close, zoom, onClick }: { b: OverviewBlock; close: boolean; zoom: number; onClick: (e: React.MouseEvent) => void }) {
  const tip = [b.kind === "doc" ? `Doc: ${b.title}` : b.title, b.status, b.step && b.step !== b.status ? b.step : null].filter(Boolean).join("\n");
  return (
    <button type="button" className="mr-ov-block" data-mr="OverviewBlock" data-mr-source={b.id} data-mr-kind={b.kind} data-s={b.lamp} aria-label={`Open ${b.title}`} title={tip} onClick={onClick} onPointerDown={(e) => e.stopPropagation()}
      style={{ height: BLOCK_H, display: "flex", gap: 8, padding: "8px 10px 8px 0", border: 0, font: "inherit", textAlign: "left", cursor: "pointer", background: "var(--mr-tile)", color: "var(--mr-ink)", overflow: "hidden" }}>
      <span aria-hidden="true" style={{ flex: "none", width: close ? 4 : 4 / Math.min(1, zoom / 0.9), alignSelf: "stretch", ...lampStyle(b.lamp, true) }} />
      <span style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 2, justifyContent: close ? undefined : "center" }}>
        <span className="mr-ellipsis" style={{ fontWeight: 600, fontSize: readable(14, zoom, 12), lineHeight: 1.2 }}>{b.kind === "doc" && <span className="mr-mono mr-dim" style={{ fontWeight: 400, fontSize: "0.85em" }}>doc · </span>}{b.title}</span>
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
