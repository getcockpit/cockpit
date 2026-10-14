import { useSyncExternalStore } from "react";

// Image review (MR-142): what the user decides about images, as data and as the reply text.
// Drafts live here, keyed by view block (or attachment path), so they survive re-renders and
// re-opening the lightbox until they are sent.

export type Pin = { x: number; y: number; note: string }; // x, y: 0-100, % of the image
/** A point in % of the image, like pins. */
export type Pt = [number, number];
/** A drawn mark (MR-143, MR-145): a freehand line, or an arrow or box dragged from a to b; a box may carry a label (MR-147). */
export type Ink = { kind: "line"; pts: Pt[] } | { kind: "arrow"; a: Pt; b: Pt } | { kind: "box"; a: Pt; b: Pt; label?: string };
export type Verdict = "approve" | "reject";
export type Draft = { verdict?: Verdict; comment?: string; pins: Pin[]; ink?: Ink[] };
export type Ask = { verdict: boolean; pins: boolean };

export const EMPTY: Draft = { pins: [] };

/** `ask` from a block: 'verdict' | 'pins' | 'both' | 'none'; anything else is 'both'. */
export function askOf(v: unknown): Ask {
  const s = typeof v === "string" ? v : "both";
  return s === "none" ? { verdict: false, pins: false } : s === "verdict" ? { verdict: true, pins: false } : s === "pins" ? { verdict: false, pins: true } : { verdict: true, pins: true };
}

/** A remote or inline image the webview can load as is. */
export const isUrl = (p: string) => /^(https?:|data:image\/)/i.test(p.trim());

/** A local path made absolute against the session folder; URLs pass through. */
export function resolvePath(p: string, cwd?: string): string {
  const t = p.trim();
  if (isUrl(t) || t.startsWith("/") || /^[A-Za-z]:[\\/]/.test(t)) return t;
  if (t.startsWith("~/") || !cwd) return t;
  return `${cwd.replace(/[\\/]+$/, "")}/${t.replace(/^\.\//, "")}`;
}

export const nameOf = (p: string) => (isUrl(p) && p.startsWith("data:") ? "inline image" : p.split(/[\\/]/).filter(Boolean).pop()?.split("?")[0] ?? p);

// Where Claude can find the image again; an inline data: image has no useful address.
const where = (p: string) => (/^data:/i.test(p.trim()) ? "" : ` (${p})`);
const pct = (n: number) => `${Math.round(n)}%`;
const touched = (d: Draft) => !!(d.verdict || d.comment?.trim() || d.pins.length || d.ink?.length);
export const marked = (d: Draft) => d.pins.length + (d.ink?.length ?? 0);

/** The two back corners of an arrowhead at b, `size` long, in the same units as a and b. */
export function arrowHead(a: Pt, b: Pt, size: number): [Pt, Pt] {
  const t = Math.atan2(b[1] - a[1], b[0] - a[0]), w = Math.PI / 7;
  return [[b[0] - size * Math.cos(t - w), b[1] - size * Math.sin(t - w)], [b[0] - size * Math.cos(t + w), b[1] - size * Math.sin(t + w)]];
}
export const hasInput = (ds: Draft[]) => ds.some(touched);

function pinLines(pins: Pin[], indent: string): string[] {
  return pins.map((p, i) => `${indent}- Pin ${i + 1} at (${pct(p.x)} from left, ${pct(p.y)} from top)${p.note.trim() ? `: ${p.note.trim()}` : ""}`);
}

/**
 * A mark as polylines in pixels of a w×h image, for the screen (SVG) and the burned-in copy
 * (canvas) alike: a line as drawn, a box as its closed outline, an arrow as its shaft plus a
 * filled head sized to the image.
 */
export function inkGeometry(m: Ink, w: number, h: number): { pts: Pt[]; close?: boolean; fill?: boolean }[] {
  const px = (p: Pt): Pt => [(p[0] / 100) * w, (p[1] / 100) * h];
  if (m.kind === "line") return [{ pts: m.pts.length === 1 ? [px(m.pts[0]), [px(m.pts[0])[0] + 0.1, px(m.pts[0])[1]]] : m.pts.map(px) }];
  const a = px(m.a), b = px(m.b);
  if (m.kind === "box") return [{ pts: [a, [b[0], a[1]], b, [a[0], b[1]]], close: true }];
  const [l, r] = arrowHead(a, b, Math.max(w, h) / 40);
  return [{ pts: [a, b] }, { pts: [b, l, r], close: true, fill: true }];
}

/**
 * Where a box's label sits, in pixels of a w×h image: on top of the box's top-left corner, or
 * just inside it when the box touches the top edge. Null for marks without a label.
 */
export function inkLabel(m: Ink, w: number, h: number): { x: number; y: number; size: number; text: string } | null {
  const text = m.kind === "box" ? m.label?.trim() : "";
  if (!text || m.kind !== "box") return null;
  const size = Math.max(12, Math.round(Math.max(w, h) / 40));
  const x = (Math.min(m.a[0], m.b[0]) / 100) * w, top = (Math.min(m.a[1], m.b[1]) / 100) * h;
  return { x: x + size * 0.15, y: top - size * 0.35 < size ? top + size * 1.1 : top - size * 0.35, size, text };
}

/** Each mark in words: a drawing or box by its area, an arrow by where it starts and points. */
export function inkLines(ink: Ink[] = [], indent = ""): string[] {
  const span = (a: number[]) => (Math.round(Math.max(...a)) - Math.round(Math.min(...a)) < 2 ? pct((Math.min(...a) + Math.max(...a)) / 2) : `${pct(Math.min(...a))}–${pct(Math.max(...a))}`);
  const area = (pts: Pt[]) => `(${span(pts.map((p) => p[0]))} from left, ${span(pts.map((p) => p[1]))} from top)`;
  const n = { line: 0, arrow: 0, box: 0 };
  return ink.flatMap((m) => {
    if (m.kind === "line") return m.pts.length ? [`${indent}- Drawing ${++n.line} around ${area(m.pts)}`] : [];
    if (m.kind === "box") return [`${indent}- Box ${++n.box}${m.label?.trim() ? ` "${m.label.trim()}"` : ""} around ${area([m.a, m.b])}`];
    return [`${indent}- Arrow ${++n.arrow} from (${pct(m.a[0])}, ${pct(m.a[1])}) pointing at (${pct(m.b[0])} from left, ${pct(m.b[1])} from top)`];
  });
}

function verdictWord(d: Draft): string {
  return d.verdict === "approve" ? "✓ Approved" : d.verdict === "reject" ? "✗ Rejected" : d.comment?.trim() || marked(d) ? "Comment" : "No verdict";
}

const copyLine = (path: string | undefined, indent: string) => (path ? [`${indent}- Drawn-on copy: ${path}`] : []);

/** The one reply a gallery review sends: per image its verdict, comment and pins, with the path. */
export function reviewReply(items: { path: string; caption?: string }[], drafts: Draft[], copies: (string | undefined)[] = []): string {
  const lines = [`Image review (${items.length} image${items.length === 1 ? "" : "s"}):`];
  items.forEach((it, i) => {
    const d = drafts[i] ?? EMPTY;
    const comment = d.comment?.trim();
    lines.push(`${i + 1}. ${verdictWord(d)} · ${it.caption?.trim() || nameOf(it.path)}${where(it.path)}${comment ? `: "${comment}"` : ""}`);
    lines.push(...pinLines(d.pins, "   "), ...inkLines(d.ink, "   "), ...copyLine(copies[i], "   "));
  });
  return lines.join("\n");
}

/** The reply a before/after review sends. Pins are on the after image. */
export function compareReply(before: string, after: string, d: Draft, b: Draft = { pins: [] }, copies: (string | undefined)[] = []): string {
  const comment = d.comment?.trim();
  const lines = [`Before/after review: ${verdictWord(d)} · ${nameOf(before)} → ${nameOf(after)}${/^data:/i.test(before + after) ? "" : ` (${before} → ${after})`}${comment ? `: "${comment}"` : ""}`];
  if (marked(b)) lines.push("On the before image:", ...pinLines(b.pins, ""), ...inkLines(b.ink), ...copyLine(copies[0], ""));
  if (marked(d)) lines.push("On the after image:", ...pinLines(d.pins, ""), ...inkLines(d.ink), ...copyLine(copies[1], ""));
  return lines.join("\n");
}

/** Pins on your own attachments, appended to the message so Claude knows where to look. */
export function attachmentNotes(files: { path: string; name: string }[], draftOf: (path: string) => Draft, copies: Record<string, string> = {}): string {
  const parts = files.map((f) => ({ f, d: draftOf(f.path) })).filter((x) => marked(x.d));
  return parts.map(({ f, d }) => [`Notes on ${f.name} (${f.path}):`, ...pinLines(d.pins, ""), ...inkLines(d.ink), ...(copies[f.path] ? [`- Drawn-on copy attached: ${copies[f.path]}`] : [])].join("\n")).join("\n\n");
}

// The draft store: one entry per key, a version bump per change, so components re-render on it.
const drafts = new Map<string, Draft[]>();
const sent = new Set<string>();
const subs = new Set<() => void>();
let version = 0;
const bump = () => { version++; subs.forEach((f) => f()); };
const subscribe = (f: () => void) => { subs.add(f); return () => subs.delete(f); };

export function getDrafts(key: string, n: number): Draft[] {
  const d = drafts.get(key) ?? [];
  return Array.from({ length: n }, (_, i) => d[i] ?? EMPTY);
}
export function setDraft(key: string, i: number, patch: Partial<Draft>) {
  const d = [...(drafts.get(key) ?? [])];
  d[i] = { ...(d[i] ?? EMPTY), ...patch };
  drafts.set(key, d);
  bump();
}
export function clearDrafts(key: string) { drafts.delete(key); bump(); }
export function markSent(key: string) { sent.add(key); bump(); }
export const isSent = (key: string) => sent.has(key);

/** Re-render on any draft change. */
export function useDrafts(): number {
  return useSyncExternalStore(subscribe, () => version);
}
