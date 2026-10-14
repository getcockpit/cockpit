import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type WheelEvent } from "react";
import { createPortal } from "react-dom";
import { api } from "../state/store";
import { Key } from ".";
import { keyOf } from "./keys";
import { EMPTY, isUrl, type Ask, type Draft, type Pin } from "./reviewDraft";

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

const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
const MIN = 0.5, MAX = 8;

/**
 * Images at full size over everything. Wheel zooms around the pointer, drag pans, ←/→ move
 * between images, 0 fits. With `ask.pins` a click drops a numbered pin with a note; with
 * `ask.verdict` A approves, R rejects and C writes a comment. Esc closes.
 */
export function Lightbox({ images, start = 0, ask = { verdict: false, pins: false }, drafts = [], onDraft, onClose, source }: {
  images: LbImage[]; start?: number; ask?: Ask; drafts?: Draft[]; onDraft?: (i: number, patch: Partial<Draft>) => void; onClose: () => void; source?: string;
}) {
  const [i, setI] = useState(Math.min(start, images.length - 1));
  const [view, setView] = useState({ s: 1, x: 0, y: 0 });
  const [focusPin, setFocusPin] = useState<number | null>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);
  const img = useRef<HTMLImageElement>(null);
  const comment = useRef<HTMLTextAreaElement>(null);
  const im = images[i];
  const src = useImageSrc(im?.path ?? null);
  const d = drafts[i] ?? EMPTY;
  const edit = onDraft && (ask.pins || ask.verdict);

  const go = (n: number) => { setI((n + images.length) % images.length); setView({ s: 1, x: 0, y: 0 }); setFocusPin(null); };
  const verdict = (v: Draft["verdict"]) => onDraft?.(i, { verdict: d.verdict === v ? undefined : v });

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const key = keyOf(e);
      if (key === "Escape") {
        e.preventDefault(); e.stopPropagation();
        if (typing(e.target)) (e.target as HTMLElement).blur(); else onClose();
        return;
      }
      if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const took = () => { e.preventDefault(); e.stopPropagation(); };
      if (key === "ArrowRight" && images.length > 1) { took(); go(i + 1); }
      else if (key === "ArrowLeft" && images.length > 1) { took(); go(i - 1); }
      else if (key === "0") { took(); setView({ s: 1, x: 0, y: 0 }); }
      else if (edit && ask.verdict && key === "a") { took(); verdict("approve"); }
      else if (edit && ask.verdict && key === "r") { took(); verdict("reject"); }
      else if (edit && ask.verdict && key === "c") { took(); comment.current?.focus(); }
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
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
  };
  const onMove = (e: MouseEvent) => {
    const g = drag.current;
    if (!g) return;
    const dx = e.clientX - g.x, dy = e.clientY - g.y;
    if (!g.moved && Math.hypot(dx, dy) < 4) return;
    g.moved = true;
    setView((v) => ({ ...v, x: g.vx + dx, y: g.vy + dy }));
  };
  const onUp = (e: MouseEvent) => {
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
          {images.length > 1 && <span className="mr-mono mr-dim" style={{ fontSize: 12 }}>{i + 1} / {images.length}</span>}
          <span className="mr-grow" />
          <span className="mr-mono mr-dim" style={{ fontSize: 12 }}>{Math.round(view.s * 100)}%</span>
          <Key k="0" onClick={() => setView({ s: 1, x: 0, y: 0 })}>Fit</Key>
          {images.length > 1 && <><Key onClick={() => go(i - 1)}>←</Key><Key onClick={() => go(i + 1)}>→</Key></>}
          <Key k="esc" onClick={onClose}>Close</Key>
        </div>
        <div onWheel={onWheel} onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={() => { drag.current = null; }}
          style={{ flex: 1, minHeight: 0, position: "relative", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", cursor: edit && ask.pins ? "crosshair" : view.s > 1 ? "grab" : "default", userSelect: "none" }}>
          {src === null && <span style={{ color: "var(--mr-tile)" }}>Can't load {im?.path}</span>}
          {src && (
            <div style={{ position: "relative", transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`, transformOrigin: "center", lineHeight: 0 }}>
              <img ref={img} src={src} alt={im?.name} draggable={false} style={{ display: "block", maxWidth: side ? "calc(100vw - 380px)" : "calc(100vw - 48px)", maxHeight: "calc(100vh - 120px)", objectFit: "contain", background: "var(--mr-tile)" }} />
              {d.pins.map((p, k) => (
                <button key={k} type="button" data-pin onClick={() => setFocusPin(k)} title={p.note || `Pin ${k + 1}`} aria-label={`Pin ${k + 1}`}
                  style={{ position: "absolute", left: `${p.x}%`, top: `${p.y}%`, transform: `translate(-50%, -50%) scale(${1 / view.s})`, width: 24, height: 24, minHeight: 0, padding: 0, border: 0, borderRadius: "50%", font: "inherit", fontSize: 12, fontWeight: 700, lineHeight: "24px", cursor: "pointer",
                    background: focusPin === k ? "var(--mr-selected)" : "var(--mr-needs)", color: "var(--mr-ink)", boxShadow: "0 0 0 2px var(--mr-tile)" }}>{k + 1}</button>
              ))}
            </div>
          )}
        </div>
        <div style={{ ...bar, justifyContent: "center", background: "transparent", color: "var(--mr-tile)", fontSize: 12 }} className="mr-mono">
          Scroll to zoom · drag to pan{edit && ask.pins ? " · click to pin a note" : ""}{edit && ask.verdict ? " · A approve · R reject · C comment" : ""}{images.length > 1 ? " · ←/→ next" : ""} · Esc to close
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
