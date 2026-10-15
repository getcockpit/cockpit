import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { keyLabel } from "../platform";
import { StateMark } from "../components";
import type { Doc } from "../state/docs";
import type { AppState } from "../state/types";
import type { TileSpec } from "../picker/pick";
import { bounds, columns, BLOCK_GAP, BLOCK_H, detail, fit, GROUP_LABEL, GROUPS, HEADER_H, LABEL_H, MAX_ZOOM, MIN_ZOOM, overview, PAD, readable, settle, shown, zoomAt, nearest, actualSize, revealBy, anyInView, wheelCam, pinchCam, farSizes, type Layout, type OverviewArea, type OverviewBlock } from "../state/overview";
import { isTyping, overviewKey } from "../components/keys";

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
// The last ⌘0 / Fit all request handled, so coming back to the Overview restores where you left it
// instead of re-running an old fit (the app's counter only ever grows).
let fitSeen = 0;

// Every tile state has a lamp you can see (an unmapped one fell back to the pale "off" grey and vanished).
export const LAMP: Record<TileSpec["state"], string> = { needs_you: "var(--mr-needs)", error: "var(--mr-error)", review: "var(--mr-ink)", working: "var(--mr-ink-3)", idle: "var(--mr-ink-3)", almost: "var(--mr-ink-3)", starting: "var(--mr-ink-3)", done: "var(--mr-done)", interrupted: "var(--mr-ink-2)" };
// Stopped work waiting for a resume reads as an empty lamp: nothing is running there.
// On a block's thin edge that's a dashed bar; on the far view's squares, a hollow one.
const lampStyle = (s: string, bar = false): React.CSSProperties => (s !== "interrupted" ? { background: LAMP[s as TileSpec["state"]] ?? "var(--mr-lamp-off)" }
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
  // Each spot is let go once its own event has replayed: a drop sends one event per workspace, and
  // clearing them all on the first would make the dragged one jump back for a frame.
  useEffect(() => setHeld((h) => {
    const left = Object.fromEntries(Object.entries(h).filter(([ws, p]) => { const l = state.overviewLayout[ws]; return !l || Math.abs(l.x - p.x) > 1 || Math.abs(l.y - p.y) > 1; }));
    return Object.keys(left).length === Object.keys(h).length ? h : left;
  }), [state.overviewLayout]);
  const aspect = size.w && size.h ? size.w / size.h : undefined;
  const areas = useMemo(() => overview(state, docs, { ...state.overviewLayout, ...held }, aspect), [state, docs, held, aspect]);
  // Fit into the part of the canvas above the zoom bar, so nothing starts hidden under it.
  const fitNow = (smooth: boolean) => { if (!size.w) return; following = true; (smooth ? glideTo : setCam)(fit(bounds(areas), { w: size.w, h: Math.max(1, size.h - BAR_H) })); };
  const fitAll = () => fitNow(true);
  const box = bounds(areas);
  const boxKey = `${box.x},${box.y},${box.w},${box.h}`;
  // The first fit waits for a real size (a hidden window measures 0 × 0); a pan or zoom made before it
  // sets the camera, so it never undoes that.
  useLayoutEffect(() => { if (size.w && (!lastCam || fitSignal !== fitSeen)) { fitSeen = fitSignal; fitNow(!!lastCam); } }, [fitSignal, size.w > 0]);
  // While it follows, keep it fitted; not while a rectangle is being dragged (the camera would chase it).
  // A resize refits at once (the window is moving under you); a map change, like a new session, glides.
  useLayoutEffect(() => { if (following && size.w && !drag.current) fitNow(false); }, [size.w, size.h]);
  const firstBox = useRef(true);
  useLayoutEffect(() => { if (firstBox.current) { firstBox.current = false; return; } if (following && size.w && !drag.current) fitNow(true); }, [boxKey]);
  // Far out a click zooms into that workspace (close enough to read it) instead of leaving the map.
  // The second click of a double-click would land on the now-readable workspace and open it: clicks
  // right after a zoom-in are swallowed.
  const zoomedAt = useRef(0);
  const zoomTo = (a: OverviewArea) => { following = false; zoomedAt.current = Date.now(); glideTo(fit(a, { w: size.w, h: Math.max(1, size.h - BAR_H) })); };
  // 100% lands on the workspace nearest the middle of the view, not on whatever gap happens to be there.
  const toActual = () => {
    const vh = Math.max(1, size.h - BAR_H);
    const a = nearest(areas, (size.w / 2 - cam.x) / cam.zoom, (vh / 2 - cam.y) / cam.zoom);
    following = false;
    if (a) glideTo(actualSize(a, { w: size.w, h: vh }));
    else zoomBy(1 / cam.zoom);
  };
  const zoomBy = (by: number) => { following = false; glideTo((c) => zoomAt(c, size.w / 2, (size.h - BAR_H) / 2, by)); };

  // Wheel: pan in any direction; pinch (ctrl+wheel in Chromium) or ⌘-scroll zooms. WebKit's trackpad
  // pinch arrives as gesture events instead. Native listeners: React's wheel handler is passive.
  useEffect(() => {
    const el = view.current;
    if (!el) return;
    const at = (e: { clientX: number; clientY: number }) => { const r = el.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] as const; };
    let scale = 1, pinching = false;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const [px, py] = at(e);
      byHand((c) => wheelCam(c, e, px, py, pinching));
    };
    const gStart = (e: Event) => { e.preventDefault(); scale = 1; pinching = true; };
    const gChange = (e: Event) => {
      e.preventDefault();
      const g = e as Event & { scale: number; clientX: number; clientY: number };
      const [px, py] = at(g);
      const prev = scale;
      byHand((c) => pinchCam(c, g.scale, prev, px, py));
      scale = g.scale;
    };
    const gEnd = (e: Event) => { e.preventDefault(); pinching = false; };
    el.addEventListener("wheel", wheel, { passive: false });
    el.addEventListener("gesturestart", gStart);
    el.addEventListener("gesturechange", gChange);
    el.addEventListener("gestureend", gEnd);
    return () => { el.removeEventListener("wheel", wheel); el.removeEventListener("gesturestart", gStart); el.removeEventListener("gesturechange", gChange); el.removeEventListener("gestureend", gEnd); };
  }, []);

  // + / − zoom around the middle, arrows pan.
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e) => {
    const k = overviewKey(e, { dialog: !!document.querySelector('[role="dialog"]'), menu: !!document.querySelector("[data-mr-menu]") });
    if (!k) return;
    e.preventDefault();
    if (k.do === "back") onBack();
    else if (k.do === "zoom") zoomBy(k.by);
    else { following = false; glideTo((c) => ({ ...c, x: c.x + k.dx, y: c.y + k.dy })); }
  };
  useEffect(() => { const on = (e: KeyboardEvent) => keyRef.current(e); window.addEventListener("keydown", on); return () => window.removeEventListener("keydown", on); }, []);

  // Space held: any drag pans, even over a workspace (Miro, Figma). Only a button focused from the
  // keyboard keeps its Space; Chromium focuses a button on every mouse click, and that one mustn't
  // turn Space-drag into moving (and saving) a workspace. Taken, Space is cancelled on the way up
  // too, so the clicked button isn't pressed.
  const space = useRef(false);
  const [, setSpaceCursor] = useState(false);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key !== " " || e.repeat && space.current) { if (e.key === " " && space.current) e.preventDefault(); return; }
      const t = e.target as HTMLElement | null;
      if (isTyping(t) || t?.closest?.("[role=dialog], [data-mr-menu]") || keyboardFocused(t?.closest?.("button") ?? null)) return;
      e.preventDefault(); space.current = true; setSpaceCursor(true);
    };
    const up = (e: KeyboardEvent) => { if (e.key === " " && space.current) { e.preventDefault(); space.current = false; setSpaceCursor(false); } };
    const blur = () => { space.current = false; setSpaceCursor(false); };
    window.addEventListener("keydown", down); window.addEventListener("keyup", up); window.addEventListener("blur", blur);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); window.removeEventListener("blur", blur); };
  }, []);

  // Pointer drags: on the empty canvas, with the middle button, or with Space held they pan; anywhere
  // on a workspace (its blocks too) they move it. The pointer is captured only once it has moved, so
  // a plain click still lands on the block under it; a press that moved never opens anything.
  const drag = useRef<{ kind: "pan" | "move"; ws?: string; x0: number; y0: number; ox: number; oy: number; moved: boolean; frozen?: Layout; el: Element; id: number } | null>(null);
  const suppressClick = useRef(false);
  const down = (e: React.PointerEvent, ws?: string) => {
    if (e.button !== 0 && e.button !== 1) return;
    const pan = e.button === 1 || space.current; // pan wherever the press lands
    // The canvas itself only takes a plain press on its empty background (a workspace handles its own).
    if (!ws && !pan && e.target !== e.currentTarget) return;
    if (ws) e.stopPropagation();
    if (e.button === 1) e.preventDefault(); // no autoscroll
    const a = ws && !pan ? areas.find((x) => x.workspace === ws) : null;
    // Freeze every rectangle where it is, so moving one doesn't shuffle the ones still auto-placed.
    const frozen = a ? Object.fromEntries(areas.map((x) => [x.workspace, { x: x.x, y: x.y }])) : undefined;
    drag.current = { kind: a ? "move" : "pan", ws: a ? ws : undefined, x0: e.clientX, y0: e.clientY, ox: a ? a.x : cam.x, oy: a ? a.y : cam.y, moved: false, frozen, el: e.currentTarget, id: e.pointerId };
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x0, dy = e.clientY - d.y0;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    if (!d.moved) try { d.el.setPointerCapture(d.id); } catch { /* the pointer is already gone */ }
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
    if (moved && spot) {
      setHeld((h) => ({ ...h, [moved.workspace]: spot }));
      // Nowhere free in sight: it goes off screen, so the camera follows it there.
      const { dx, dy } = revealBy({ ...moved, ...spot }, cam, { w: size.w, h: Math.max(1, size.h - BAR_H) });
      if (dx || dy) glideTo((c) => ({ ...c, x: c.x + dx, y: c.y + dy }));
    }
    // The moved one, plus any still auto-placed: their spots are now fixed too, so nothing jumps later.
    for (const a of areas) if (a.workspace === d.ws || !state.overviewLayout[a.workspace]) void invoke("overview_move", { workspace: a.workspace, ...(a.workspace === d.ws && spot ? spot : { x: a.x, y: a.y }) }).catch(() => {});
  };
  const click = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    if (suppressClick.current) { suppressClick.current = false; return; }
    if (Date.now() - zoomedAt.current < 450) return;
    fn();
  };
  // Double-click the empty canvas to zoom in there.
  const dbl = (e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return;
    const r = view.current!.getBoundingClientRect();
    following = false;
    glideTo((c) => zoomAt(c, e.clientX - r.left, e.clientY - r.top, 2));
  };

  // Tabbing to a block or workspace off screen brings it into view. The browser would scroll the
  // clipped canvas itself instead (so would find-in-page or scrollIntoView, which onScroll undoes),
  // and the camera would no longer match what's drawn: undo that, pan.
  const focused = (e: React.FocusEvent) => {
    const el = view.current;
    if (!el) return;
    focusWs.current = (e.target as HTMLElement).closest?.('[data-mr="OverviewArea"]')?.getAttribute("data-mr-source") ?? null;
    el.scrollLeft = 0; el.scrollTop = 0;
    // Only keyboard focus: a click on a half-hidden block must land on it, not chase a moving camera.
    if (!(e.target as HTMLElement).matches(":focus-visible")) return;
    const v = el.getBoundingClientRect(), r = (e.target as HTMLElement).getBoundingClientRect(), m = 24, mb = 64; // the zoom bar sits along the bottom
    const dx = r.left < v.left + m ? v.left + m - r.left : r.right > v.right - m ? Math.max(v.right - m - r.right, v.left + m - r.left) : 0;
    const dy = r.top < v.top + m ? v.top + m - r.top : r.bottom > v.bottom - mb ? Math.max(v.bottom - mb - r.bottom, v.top + m - r.top) : 0;
    if (dx || dy) { following = false; glideTo((c) => ({ ...c, x: c.x + dx, y: c.y + dy })); }
  };

  const level = detail(cam.zoom);
  // Zooming across a detail level swaps a workspace's far button for its header and blocks (and back):
  // keyboard focus that was on the old one moves to the new header, instead of falling to the page.
  const focusWs = useRef<string | null>(null);
  useLayoutEffect(() => {
    const ws = focusWs.current;
    if (!ws || (document.activeElement && document.activeElement !== document.body)) return;
    view.current?.querySelector<HTMLElement>(`[data-mr="OverviewHeader"][data-mr-source="${CSS.escape(ws)}"]`)?.focus({ preventScroll: true });
  }, [level]);
  const moving = drag.current?.kind === "move" ? drag.current.ws : null;
  return (
    <div ref={view} data-mr="OverviewCanvas" data-mr-source="overview" data-zoom={level} data-fitted={following && lastCam ? "" : undefined} role="region" aria-roledescription="canvas" aria-label="Overview of every workspace. Plus and minus zoom, arrows pan, Escape goes back." onPointerDown={(e) => down(e)} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onLostPointerCapture={up} onDoubleClick={dbl} onFocus={focused} onScroll={(e) => { e.currentTarget.scrollLeft = 0; e.currentTarget.scrollTop = 0; }}
      style={{ position: "relative", height: "100%", overflow: "hidden", background: "var(--mr-base)", touchAction: "none", cursor: drag.current?.kind === "pan" ? "grabbing" : space.current ? "grab" : "default" }}>
      <div className="mr-ov-cam" data-glide={glide || undefined} style={{ ["--mr-ov-z" as string]: cam.zoom, position: "absolute", left: 0, top: 0, transformOrigin: "0 0", transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.zoom})`, pointerEvents: "none" }}>
        {areas.map((a) => <Area key={a.workspace} a={a} level={level} zoom={cam.zoom} lifted={moving === a.workspace}
          onDown={(e) => down(e, a.workspace)}
          onOpen={click(() => onOpenWorkspace(a.workspace))}
          onZoomTo={click(() => zoomTo(a))}
          onBlock={(b) => click(() => (b.kind === "session" ? onOpenSession(a.workspace, b.id) : onOpenDoc(a.workspace, b.id)))} />)}
      </div>
      {/* Panned off into empty canvas: say so, and offer the way back. */}
      {size.w > 0 && areas.length > 0 && !anyInView(areas, cam, { w: size.w, h: size.h - BAR_H }) && (
        <div data-mr="OverviewLost" style={{ display: "flex", flexDirection: "column", position: "absolute", left: 0, right: 0, top: 0, bottom: BAR_H, alignItems: "center", justifyContent: "center", gap: 10, pointerEvents: "none" }}>
          <span className="mr-dim">Nothing here</span>
          <button type="button" className="mr-key" data-tone="primary" style={{ pointerEvents: "auto" }} onClick={fitAll}><kbd>{keyLabel("⌘0")}</kbd>Back to your workspaces</button>
        </div>
      )}
      {/* The bottom strip: its own band, so the map never shows through the hint and the zoom buttons. */}
      <div className="mr-row" data-mr="OverviewBar" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
        style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: BAR_H, padding: "0 12px", gap: 12, background: "var(--mr-base)", boxShadow: "0 -1px 0 var(--mr-well)" }}>
      <div className="mr-row mr-dim mr-grow" data-mr="OverviewHint" style={{ minWidth: 0, fontSize: 12, pointerEvents: "none", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        <span className="mr-ellipsis">Scroll, drag empty space or Space-drag to pan · pinch, {keyLabel("⌘")}-scroll or +/− to zoom · drag a workspace to move it</span>
      </div>
      <div className="mr-row" data-mr="OverviewZoom" style={{ flex: "none", gap: 4 }}>
        <button type="button" className="mr-key" aria-label="Zoom out" title="Zoom out (−)" disabled={cam.zoom <= MIN_ZOOM + 1e-6} onClick={() => zoomBy(1 / 1.25)}>−</button>
        <button type="button" className="mr-mono mr-dim" data-mr="OverviewZoomLevel" aria-label={`Zoom ${Math.round(cam.zoom * 100)}%: go to 100%`} title="Zoom to 100%" onClick={toActual}
          style={{ minWidth: 48, minHeight: 36, textAlign: "center", fontSize: 12, border: 0, background: "transparent", cursor: "pointer", color: "inherit" }}>{Math.round(cam.zoom * 100)}%</button>
        <button type="button" className="mr-key" aria-label="Zoom in" title="Zoom in (+)" disabled={cam.zoom >= MAX_ZOOM - 1e-6} onClick={() => zoomBy(1.25)}>+</button>
        <button type="button" className="mr-key" onClick={fitAll}><kbd>{keyLabel("⌘0")}</kbd>Fit all</button>
      </div>
      </div>
    </div>
  );
}

/** A button focused from the keyboard (Tab), as opposed to one a mouse click happened to focus. */
function keyboardFocused(b: Element | null): boolean {
  if (!b) return false;
  try { return b.matches(":focus-visible"); } catch { return true; }
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

/** What a screen reader hears after a workspace's name: its counts, needs you first. */
export const said = (a: Pick<OverviewArea, "counts">) => countLabels(a.counts).map((l) => `, ${l.title}`).join("");

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
      style={{ position: "absolute", left: a.x, top: a.y, width: a.w, height: a.h, overflow: "hidden", background: "var(--mr-band)", pointerEvents: "auto", cursor: lifted ? "grabbing" : "inherit", touchAction: "none", outline: lifted ? `${3 / zoom}px solid var(--mr-selected)` : undefined, zIndex: lifted ? 1 : undefined }}>
      {far ? <Far a={a} zoom={zoom} onOpen={onZoomTo} /> : <>
        <button type="button" data-mr="OverviewHeader" data-mr-source={a.workspace} aria-label={`Open workspace ${a.name}${said(a)}`} onClick={onOpen}
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
          : columns(a.groups).map(({ group: g, x, w }) => (
            <div key={g} data-mr="OverviewGroup" data-mr-source={`${a.workspace}:${g}`} style={{ position: "absolute", left: x, top: HEADER_H, width: w, display: "flex", flexDirection: "column", gap: BLOCK_GAP }}>
              <span className="mr-dim mr-ellipsis" style={{ height: LABEL_H - BLOCK_GAP, fontSize: Math.min(readable(12, zoom, 10), LABEL_H - BLOCK_GAP), lineHeight: 1, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" }}>{GROUP_LABEL[g]}{a.groups[g].length ? ` · ${a.groups[g].length}` : ""}</span>
              {(() => { const v = shown(a.groups[g]); return <>
                    {v.blocks.map((b) => <Block key={`${b.kind}:${b.id}`} b={b} close={close} zoom={zoom} onClick={onBlock(b)} />)}
                    {v.more > 0 && <button type="button" className="mr-ov-block" data-mr="OverviewMore" data-mr-source={`${a.workspace}:${g}`} onClick={onOpen}
                      aria-label={`${v.more} more in ${GROUP_LABEL[g]}: open workspace ${a.name}`}
                      style={{ height: BLOCK_H, border: 0, font: "inherit", fontWeight: 600, fontSize: readable(14, zoom, 12), cursor: "pointer", background: "var(--mr-well)", color: "var(--mr-ink-2)" }}>+{v.more} more</button>}
                  </>; })()}
            </div>
          ))}
      </>}
    </div>
  );
}

/** Far out: the name, what needs you, and one lamp per open item, sized to stay legible over the rectangle. */
function Far({ a, zoom, onOpen }: { a: OverviewArea; zoom: number; onOpen: (e: React.MouseEvent) => void }) {
  // Sized to the rectangle's height (farSizes): the name first, the lamps take what's left.
  const { name, lamp, pad, gap, note } = farSizes(a.h, zoom);
  const all = lamps(a);
  return (
    <button type="button" data-mr="OverviewHeader" data-mr-source={a.workspace} aria-label={`Zoom to workspace ${a.name}${said(a)}`} onClick={onOpen}
      style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", alignItems: "flex-start", justifyContent: "flex-start", gap, padding: pad, border: 0, background: "transparent", font: "inherit", textAlign: "left", cursor: "inherit", color: "var(--mr-ink)", overflow: "hidden" }}>
      {/* The name gets the whole width; what needs you leads the lamp row instead of crowding it. */}
      <strong className="mr-ellipsis" style={{ fontSize: name, lineHeight: 1.1, maxWidth: "100%" }}>{a.name}</strong>
      {all.length
        ? <span data-mr="OverviewLamps" data-mr-source={a.workspace} aria-hidden="true" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: lamp * 0.4 }}>
            {a.counts.needs > 0 && <span data-mr="OverviewCount" data-mr-source={`${a.workspace}:needs`} className="mr-mono" title={`${a.counts.needs} need${a.counts.needs === 1 ? "s" : ""} you`}
              style={{ flex: "none", fontSize: lamp * 1.1, lineHeight: 1, fontWeight: 700, padding: `${lamp * 0.1}px ${lamp * 0.25}px`, marginRight: lamp * 0.3, background: "var(--mr-needs)" }}>⚠ {a.counts.needs}</span>}
            {all.map((b) => <span key={`${b.kind}:${b.id}`} data-s={b.lamp} style={{ width: lamp, height: lamp, ...lampStyle(b.lamp) }} />)}
          </span>
        : <span className="mr-dim" style={{ fontSize: note, lineHeight: 1 }}>Nothing open</span>}
    </button>
  );
}

function Block({ b, close, zoom, onClick }: { b: OverviewBlock; close: boolean; zoom: number; onClick: (e: React.MouseEvent) => void }) {
  const tip = [b.kind === "doc" ? `Doc: ${b.title}` : b.title, b.status, b.step && b.step !== b.status ? b.step : null].filter(Boolean).join("\n");
  return (
    <button type="button" className="mr-ov-block" data-mr="OverviewBlock" data-mr-source={b.id} data-mr-kind={b.kind} data-s={b.lamp} aria-label={`Open ${b.title}, ${b.status}`} title={tip} onClick={onClick}
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
