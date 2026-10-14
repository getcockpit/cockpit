import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type WheelEvent } from "react";
import { createPortal } from "react-dom";
import { api } from "../state/store";
import { Key } from ".";
import { keyOf } from "./keys";
import { EMPTY, inkGeometry, inkLabel, isUrl, type Ask, type Draft, type Ink, type Pin, type Pt } from "./reviewDraft";

// Image sources (MR-142): a URL loads as is; a local file's bytes come once through
// attachment_read (images only, size-capped) and are kept as a blob URL per path.
const urls = new Map<string, Promise<string | null>>();
export function seedPreview(path: string, blob: Blob) {
  urls.set(path, Promise.resolve(URL.createObjectURL(blob)));
}
export function previewOf(path: string): Promise<string | null> {
  if (isUrl(path)) return Promise.resolve(path.trim());
  let u = urls.get(path);
  if (!u) {
    u = api.attachmentRead(path).then((b) => URL.createObjectURL(new Blob([b]))).catch(() => null);
    urls.set(path, u);
  }
  return u;
}

/** The loadable src for a path: undefined while loading, null when it can't be read. */
export function useImageSrc(path: string | null): string | null | undefined {
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!path) { setUrl(null); return; }
    let live = true;
    setUrl(undefined);
    void previewOf(path).then((u) => live && setUrl(u));
    return () => { live = false; };
  }, [path]);
  return url;
}

export type LbImage = { path: string; name: string; caption?: string };

// Drawn marks use the error ink: they say "this is wrong" (theme: colour only for state).
const token = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
const ink = () => token("--mr-error", "red");
const LABEL_FONT = "700 SIZEpx system-ui, sans-serif";

/**
 * The image with its marks burned in, as a PNG at the image's own size (MR-143, MR-145), so Claude can
 * look at exactly what was drawn. Null when there is nothing drawn or the pixels can't be read
 * (a remote image without CORS taints the canvas).
 */
export async function burnIn(path: string, marks: Ink[] = []): Promise<Blob | null> {
  if (!marks.length) return null;
  const url = await previewOf(path);
  if (!url) return null;
  try {
    const im = new Image();
    im.crossOrigin = "anonymous";
    im.src = url;
    await im.decode();
    const w = im.naturalWidth || 1, h = im.naturalHeight || 1;
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d");
    if (!g) return null;
    g.drawImage(im, 0, 0, w, h);
    g.strokeStyle = g.fillStyle = ink(); g.lineWidth = Math.max(3, Math.round(Math.max(w, h) / 250)); g.lineCap = "round"; g.lineJoin = "round";
    for (const part of marks.flatMap((m) => inkGeometry(m, w, h))) {
      g.beginPath();
      part.pts.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y)));
      if (part.close) g.closePath();
      if (part.fill) g.fill();
      g.stroke();
    }
    // Box labels (MR-147): the error ink on a halo of the tile colour, so they read on any image.
    for (const l of marks.map((m) => inkLabel(m, w, h)).filter((x) => x !== null)) {
      g.font = LABEL_FONT.replace("SIZE", String(l.size));
      g.lineWidth = l.size / 5; g.strokeStyle = token("--mr-tile", "white");
      g.strokeText(l.text, l.x, l.y);
      g.fillStyle = ink(); g.fillText(l.text, l.x, l.y);
    }
    return await new Promise<Blob | null>((ok) => c.toBlob((b) => ok(b), "image/png"));
  } catch { return null; }
}

/** Saves a drawn-on copy next to the attachments; its path, or undefined when there's none. */
export async function saveDrawn(path: string, name: string, marks?: Ink[]): Promise<string | undefined> {
  const b = await burnIn(path, marks);
  if (!b) return undefined;
  try { return (await api.attachmentSave(b, `${name.replace(/\.[^.]+$/, "") || "image"}-drawn.png`)).path; } catch { return undefined; }
}

type Tool = "pin" | "line" | "arrow" | "box";
const TOOLS: { tool: Tool; key: string; label: string }[] = [
  { tool: "pin", key: "p", label: "Pin" }, { tool: "line", key: "d", label: "Draw" }, { tool: "arrow", key: "w", label: "Arrow" }, { tool: "box", key: "b", label: "Box" },
];
const TOOL_KEY: Record<string, Tool> = Object.fromEntries(TOOLS.map((t) => [t.key, t.tool]));

const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
const MIN = 0.5, MAX = 8;

/**
 * Images at full size over everything. Wheel zooms around the pointer, drag pans, ←/→ move
 * between images, 0 fits. With `ask.pins` a click drops a numbered pin with a note; Draw (D),
 * Arrow (W) and Box (B) turn a drag into that mark (U or ⌘Z undoes the last); with `ask.verdict` A approves, R rejects and
 * C writes a comment. Esc closes.
 */
export function Lightbox({ images, start = 0, ask = { verdict: false, pins: false }, drafts = [], onDraft, onClose, source }: {
  images: LbImage[]; start?: number; ask?: Ask; drafts?: Draft[]; onDraft?: (i: number, patch: Partial<Draft>) => void; onClose: () => void; source?: string;
}) {
  const [i, setI] = useState(Math.min(start, images.length - 1));
  const [view, setView] = useState({ s: 1, x: 0, y: 0 });
  const [focusPin, setFocusPin] = useState<number | null>(null);
  const [focusBox, setFocusBox] = useState<number | null>(null); // a new box's label field
  const [tool, setTool] = useState<Tool>("pin");
  const [live, setLive] = useState<Ink | null>(null); // the mark being drawn
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null); // the image's own size
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);
  const img = useRef<HTMLImageElement>(null);
  const comment = useRef<HTMLTextAreaElement>(null);
  const im = images[i];
  const src = useImageSrc(im?.path ?? null);
  const d = drafts[i] ?? EMPTY;
  const edit = onDraft && (ask.pins || ask.verdict);

  const go = (n: number) => { setI((n + images.length) % images.length); setView({ s: 1, x: 0, y: 0 }); setFocusPin(null); setNat(null); };
  const verdict = (v: Draft["verdict"]) => onDraft?.(i, { verdict: d.verdict === v ? undefined : v });
  const marks = d.ink ?? [];
  const undo = () => marks.length && onDraft?.(i, { ink: marks.slice(0, -1) });
  const draw = !!(edit && ask.pins && tool !== "pin");
  const at = (e: { clientX: number; clientY: number }): Pt | null => {
    const r = img.current?.getBoundingClientRect();
    if (!r) return null;
    const x = ((e.clientX - r.left) / r.width) * 100, y = ((e.clientY - r.top) / r.height) * 100;
    return [Math.max(0, Math.min(100, x)), Math.max(0, Math.min(100, y))];
  };

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const key = keyOf(e);
      if (key === "Escape") {
        e.preventDefault(); e.stopPropagation();
        if (typing(e.target)) (e.target as HTMLElement).blur(); else onClose();
        return;
      }
      const took = () => { e.preventDefault(); e.stopPropagation(); };
      if (!typing(e.target) && (e.metaKey || e.ctrlKey) && key === "z" && edit && ask.pins) { took(); undo(); return; }
      if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (key === "ArrowRight" && images.length > 1) { took(); go(i + 1); }
      else if (key === "ArrowLeft" && images.length > 1) { took(); go(i - 1); }
      else if (key === "0") { took(); setView({ s: 1, x: 0, y: 0 }); }
      else if (edit && ask.verdict && key === "a") { took(); verdict("approve"); }
      else if (edit && ask.verdict && key === "r") { took(); verdict("reject"); }
      else if (edit && ask.verdict && key === "c") { took(); comment.current?.focus(); }
      else if (edit && ask.pins && TOOL_KEY[key]) { took(); setTool(TOOL_KEY[key]); }
      else if (edit && ask.pins && key === "u") { took(); undo(); }
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  });

  const onWheel = (e: WheelEvent) => {
    const s = Math.max(MIN, Math.min(MAX, view.s * Math.exp(-e.deltaY * 0.0015)));
    const r = e.currentTarget.getBoundingClientRect();
    const cx = e.clientX - r.left - r.width / 2, cy = e.clientY - r.top - r.height / 2;
    // Keep the point under the cursor still while scaling.
    setView({ s, x: cx - ((cx - view.x) * s) / view.s, y: cy - ((cy - view.y) * s) / view.s });
  };
  const onDown = (e: MouseEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("[data-pin]")) return;
    if (draw) {
      const p = at(e);
      if (p) setLive(tool === "line" ? { kind: "line", pts: [p] } : { kind: tool, a: p, b: p });
      return;
    }
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
  };
  const onMove = (e: MouseEvent) => {
    if (live) {
      const p = at(e);
      if (!p) return;
      if (live.kind !== "line") setLive({ ...live, b: p });
      else if (Math.hypot(p[0] - live.pts[live.pts.length - 1][0], p[1] - live.pts[live.pts.length - 1][1]) > 0.3) setLive({ ...live, pts: [...live.pts, p] });
      return;
    }
    const g = drag.current;
    if (!g) return;
    const dx = e.clientX - g.x, dy = e.clientY - g.y;
    if (!g.moved && Math.hypot(dx, dy) < 4) return;
    g.moved = true;
    setView((v) => ({ ...v, x: g.vx + dx, y: g.vy + dy }));
  };
  const endMark = () => {
    if (!live) return;
    setLive(null);
    const r = (p: Pt): Pt => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10];
    // An arrow or box needs a drag; a click with those tools would only leave a speck.
    if (live.kind !== "line" && Math.hypot(live.b[0] - live.a[0], live.b[1] - live.a[1]) < 1) return;
    onDraft?.(i, { ink: [...marks, live.kind === "line" ? { kind: "line", pts: live.pts.map(r) } : { kind: live.kind, a: r(live.a), b: r(live.b) }] });
    if (live.kind === "box") setFocusBox(marks.length);
  };
  const onUp = (e: MouseEvent) => {
    if (live) { endMark(); return; }
    const g = drag.current;
    drag.current = null;
    if (!g || g.moved || !img.current) return;
    const r = img.current.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) { if (view.s === 1 && !edit) onClose(); return; }
    if (!(edit && ask.pins)) return;
    const pin: Pin = { x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100, note: "" };
    onDraft?.(i, { pins: [...d.pins, pin] });
    setFocusPin(d.pins.length);
  };
  const setLabel = (k: number, label: string) => onDraft?.(i, { ink: marks.map((m, j) => (j === k && m.kind === "box" ? { ...m, label } : m)) });
  const setPin = (k: number, note: string) => onDraft?.(i, { pins: d.pins.map((p, j) => (j === k ? { ...p, note } : p)) });
  const dropPin = (k: number) => onDraft?.(i, { pins: d.pins.filter((_, j) => j !== k) });

  const side = edit && (ask.pins || ask.verdict);
  const bar: CSSProperties = { display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", background: "var(--mr-tile)" };

  return createPortal(
    <div role="dialog" aria-label={im?.name ?? "Image"} data-mr="Lightbox" data-mr-source={source ?? im?.path}
      style={{ position: "fixed", inset: 0, zIndex: 30, display: "flex", background: "rgba(21,24,27,.92)" }}>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <div style={bar}>
          <strong className="mr-ellipsis" style={{ minWidth: 0 }}>{im?.caption || im?.name}</strong>
          {images.length > 1 && <span className="mr-mono mr-dim" data-mr="LightboxIndex" data-mr-source={String(i)} style={{ fontSize: 12 }}>{i + 1} / {images.length}</span>}
          <span className="mr-grow" />
          <span className="mr-mono mr-dim" data-mr="LightboxZoom" data-mr-source={String(Math.round(view.s * 100))} style={{ fontSize: 12 }}>{Math.round(view.s * 100)}%</span>
          <Key k="0" onClick={() => setView({ s: 1, x: 0, y: 0 })}>Fit</Key>
          {images.length > 1 && <><Key onClick={() => go(i - 1)}>←</Key><Key onClick={() => go(i + 1)}>→</Key></>}
          <Key k="esc" onClick={onClose}>Close</Key>
        </div>
        <div onWheel={onWheel} onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={() => { drag.current = null; endMark(); }}
          style={{ flex: 1, minHeight: 0, position: "relative", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", cursor: draw ? (tool === "line" ? "cell" : "crosshair") : edit && ask.pins ? "crosshair" : view.s > 1 ? "grab" : "default", userSelect: "none" }}>
          {src === null && <span style={{ color: "var(--mr-tile)" }}>Can't load {im?.path}</span>}
          {src && (
            <div style={{ position: "relative", transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`, transformOrigin: "center", lineHeight: 0 }}>
              <img ref={img} src={src} alt={im?.name} draggable={false} onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth || 1, h: e.currentTarget.naturalHeight || 1 })} style={{ display: "block", maxWidth: side ? "calc(100vw - 380px)" : "calc(100vw - 48px)", maxHeight: "calc(100vh - 120px)", objectFit: "contain", background: "var(--mr-tile)" }} />
              {nat && (
                // In the image's own pixels, so arrowheads keep their shape (the box scales evenly).
                <svg viewBox={`0 0 ${nat.w} ${nat.h}`} aria-hidden="true" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", overflow: "visible" }}>
                  {[...marks, ...(live ? [live] : [])].flatMap((m, k) => inkGeometry(m, nat.w, nat.h).map((g, j) => {
                    const pts = g.pts.map((p) => p.join(",")).join(" ");
                    const style = { fill: g.fill ? "var(--mr-error)" : "none", stroke: "var(--mr-error)", strokeWidth: 3, strokeLinecap: "round", strokeLinejoin: "round", vectorEffect: "non-scaling-stroke" } as const;
                    return g.close ? <polygon key={`${k}.${j}`} points={pts} {...style} /> : <polyline key={`${k}.${j}`} points={pts} {...style} />;
                  }))}
                  {marks.map((m, k) => {
                    const l = inkLabel(m, nat.w, nat.h);
                    return l && <text key={`l${k}`} x={l.x} y={l.y} fontSize={l.size} fontWeight={700} fontFamily="system-ui, sans-serif" fill="var(--mr-error)" stroke="var(--mr-tile)" strokeWidth={l.size / 5} paintOrder="stroke" data-mr="BoxLabel">{l.text}</text>;
                  })}
                </svg>
              )}
              {d.pins.map((p, k) => (
                <button key={k} type="button" data-pin onClick={() => setFocusPin(k)} title={p.note || `Pin ${k + 1}`} aria-label={`Pin ${k + 1}`}
                  style={{ position: "absolute", left: `${p.x}%`, top: `${p.y}%`, transform: `translate(-50%, -50%) scale(${1 / view.s})`, width: 24, height: 24, minHeight: 0, padding: 0, border: 0, borderRadius: "50%", font: "inherit", fontSize: 12, fontWeight: 700, lineHeight: "24px", cursor: "pointer",
                    background: focusPin === k ? "var(--mr-selected)" : "var(--mr-needs)", color: "var(--mr-ink)", boxShadow: "0 0 0 2px var(--mr-tile)" }}>{k + 1}</button>
              ))}
            </div>
          )}
        </div>
        <div style={{ ...bar, justifyContent: "center", background: "transparent", color: "var(--mr-tile)", fontSize: 12 }} className="mr-mono">
          Scroll to zoom · {draw ? `drag to ${tool === "line" ? "draw" : `place ${tool === "arrow" ? "an arrow" : "a box"}`} · U undo · P pins` : `drag to pan${edit && ask.pins ? " · click to pin a note · D draw · W arrow · B box" : ""}`}{edit && ask.verdict ? " · A approve · R reject · C comment" : ""}{images.length > 1 ? " · ←/→ next" : ""} · Esc to close
        </div>
      </div>
      {side && (
        <aside data-mr="LightboxNotes" data-mr-source={im?.path} style={{ flex: "none", width: 320, display: "flex", flexDirection: "column", gap: 10, padding: 14, background: "var(--mr-tile)", overflowY: "auto" }}>
          {ask.verdict && (
            <>
              <div className="mr-row" style={{ gap: 6 }}>
                <Key k="a" pressed={d.verdict === "approve"} onClick={() => verdict("approve")}>Approve</Key>
                <Key k="r" pressed={d.verdict === "reject"} onClick={() => verdict("reject")}>Reject</Key>
              </div>
              <VerdictTag d={d} />
              <textarea ref={comment} value={d.comment ?? ""} onChange={(e) => onDraft?.(i, { comment: e.target.value })} placeholder="Comment (C)" rows={3}
                style={{ resize: "vertical", font: "inherit", padding: 8, border: 0, background: "var(--mr-well)", color: "var(--mr-ink)" }} />
            </>
          )}
          {ask.pins && (
            <>
              <div className="mr-row" style={{ gap: 6, flexWrap: "wrap" }}>
                {TOOLS.map((t) => <Key key={t.tool} k={t.key} pressed={tool === t.tool} onClick={() => setTool(t.tool)}>{t.label}</Key>)}
              </div>
              {marks.length > 0 && (
                <div className="mr-row" style={{ gap: 6 }}>
                  <span className="mr-dim mr-grow" style={{ fontSize: 12 }}>{marks.length} mark{marks.length === 1 ? "" : "s"} · Claude gets a copy with them drawn in</span>
                  <Key k="u" onClick={undo}>Undo</Key>
                </div>
              )}
              {marks.map((m, k) => m.kind === "box" && (
                <div key={k} className="mr-row" style={{ gap: 6 }}>
                  <b className="mr-mono" style={{ flex: "none", fontSize: 11, padding: "2px 6px", background: "var(--mr-well)", color: "var(--mr-error)" }}>Box {marks.slice(0, k + 1).filter((x) => x.kind === "box").length}</b>
                  <input value={m.label ?? ""} onChange={(e) => setLabel(k, e.target.value)} autoFocus={focusBox === k} onBlur={() => setFocusBox(null)} placeholder="Label this box"
                    onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                    style={{ flex: 1, minWidth: 0, font: "inherit", padding: "3px 6px", border: 0, background: "var(--mr-well)", color: "var(--mr-ink)" }} />
                </div>
              ))}
              <span className="mr-dim" style={{ fontSize: 12, fontWeight: 700 }}>Pins · {d.pins.length}</span>
              {d.pins.length === 0 && <span className="mr-dim" style={{ fontSize: 12 }}>Click the image to pin what you mean.</span>}
              {d.pins.map((p, k) => (
                <div key={k} className="mr-row" style={{ gap: 6, alignItems: "flex-start" }}>
                  <b className="mr-mono" style={{ flex: "none", width: 22, height: 22, lineHeight: "22px", textAlign: "center", borderRadius: "50%", background: focusPin === k ? "var(--mr-selected)" : "var(--mr-needs)" }}>{k + 1}</b>
                  <input value={p.note} onChange={(e) => setPin(k, e.target.value)} onFocus={() => setFocusPin(k)} autoFocus={focusPin === k} placeholder="What's wrong here?"
                    style={{ flex: 1, minWidth: 0, font: "inherit", padding: "3px 6px", border: 0, background: "var(--mr-well)", color: "var(--mr-ink)" }} />
                  <button type="button" onClick={() => dropPin(k)} aria-label={`Remove pin ${k + 1}`} title="Remove"
                    style={{ flex: "none", width: 22, height: 22, minHeight: 0, padding: 0, border: 0, background: "transparent", color: "var(--mr-ink-2)", cursor: "pointer", font: "inherit" }}>×</button>
                </div>
              ))}
            </>
          )}
        </aside>
      )}
    </div>,
    document.body,
  );
}

/** A verdict as a small coloured tag: green approved, red rejected, amber still needs you. */
export function VerdictTag({ d, pending }: { d: Draft; pending?: boolean }) {
  const t = d.verdict === "approve" ? { label: "✓ Approved", bg: "var(--mr-done)", fg: "var(--mr-tile)" }
    : d.verdict === "reject" ? { label: "✗ Rejected", bg: "var(--mr-error)", fg: "var(--mr-tile)" }
    : pending ? { label: "Needs you", bg: "var(--mr-needs)", fg: "var(--mr-ink)" } : null;
  if (!t) return null;
  return <span data-mr="VerdictTag" style={{ alignSelf: "flex-start", padding: "1px 6px", fontSize: 11, fontWeight: 700, background: t.bg, color: t.fg }}>{t.label}</span>;
}
