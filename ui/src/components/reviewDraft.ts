import { useSyncExternalStore } from "react";

// Image review (MR-142): what the user decides about images, as data and as the reply text.
// Drafts live here, keyed by view block (or attachment path), so they survive re-renders and
// re-opening the lightbox until they are sent.

export type Pin = { x: number; y: number; note: string }; // x, y: 0-100, % of the image
/** A freehand stroke (MR-143): points as [x, y] in % of the image, like pins. */
export type Stroke = [number, number][];
export type Verdict = "approve" | "reject";
export type Draft = { verdict?: Verdict; comment?: string; pins: Pin[]; strokes?: Stroke[] };
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
const touched = (d: Draft) => !!(d.verdict || d.comment?.trim() || d.pins.length || d.strokes?.length);
export const marked = (d: Draft) => d.pins.length + (d.strokes?.length ?? 0);
export const hasInput = (ds: Draft[]) => ds.some(touched);

function pinLines(pins: Pin[], indent: string): string[] {
  return pins.map((p, i) => `${indent}- Pin ${i + 1} at (${pct(p.x)} from left, ${pct(p.y)} from top)${p.note.trim() ? `: ${p.note.trim()}` : ""}`);
}

/** Where a stroke is, as the box around it: enough for Claude to look there in the image. */
export function strokeLines(strokes: Stroke[] = [], indent = ""): string[] {
  return strokes.filter((s) => s.length).map((s, i) => {
    const xs = s.map((p) => p[0]), ys = s.map((p) => p[1]);
    const span = (a: number[]) => (Math.round(Math.max(...a)) - Math.round(Math.min(...a)) < 2 ? pct((Math.min(...a) + Math.max(...a)) / 2) : `${pct(Math.min(...a))}–${pct(Math.max(...a))}`);
    return `${indent}- Drawing ${i + 1} around (${span(xs)} from left, ${span(ys)} from top)`;
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
    lines.push(...pinLines(d.pins, "   "), ...strokeLines(d.strokes, "   "), ...copyLine(copies[i], "   "));
  });
  return lines.join("\n");
}

/** The reply a before/after review sends. Pins are on the after image. */
export function compareReply(before: string, after: string, d: Draft, b: Draft = { pins: [] }, copies: (string | undefined)[] = []): string {
  const comment = d.comment?.trim();
  const lines = [`Before/after review: ${verdictWord(d)} · ${nameOf(before)} → ${nameOf(after)}${/^data:/i.test(before + after) ? "" : ` (${before} → ${after})`}${comment ? `: "${comment}"` : ""}`];
  if (marked(b)) lines.push("On the before image:", ...pinLines(b.pins, ""), ...strokeLines(b.strokes), ...copyLine(copies[0], ""));
  if (marked(d)) lines.push("On the after image:", ...pinLines(d.pins, ""), ...strokeLines(d.strokes), ...copyLine(copies[1], ""));
  return lines.join("\n");
}

/** Pins on your own attachments, appended to the message so Claude knows where to look. */
export function attachmentNotes(files: { path: string; name: string }[], draftOf: (path: string) => Draft, copies: Record<string, string> = {}): string {
  const parts = files.map((f) => ({ f, d: draftOf(f.path) })).filter((x) => marked(x.d));
  return parts.map(({ f, d }) => [`Notes on ${f.name} (${f.path}):`, ...pinLines(d.pins, ""), ...strokeLines(d.strokes), ...(copies[f.path] ? [`- Drawn-on copy attached: ${copies[f.path]}`] : [])].join("\n")).join("\n\n");
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
