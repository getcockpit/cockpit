import { useSyncExternalStore } from "react";

// Image review (MR-142): what the user decides about images, as data and as the reply text.
// Drafts live here, keyed by view block (or attachment path), so they survive re-renders and
// re-opening the lightbox until they are sent.

export type Pin = { x: number; y: number; note: string }; // x, y: 0-100, % of the image
export type Verdict = "approve" | "reject";
export type Draft = { verdict?: Verdict; comment?: string; pins: Pin[] };
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
const touched = (d: Draft) => !!(d.verdict || d.comment?.trim() || d.pins.length);
export const hasInput = (ds: Draft[]) => ds.some(touched);

function pinLines(pins: Pin[], indent: string): string[] {
  return pins.map((p, i) => `${indent}- Pin ${i + 1} at (${pct(p.x)} from left, ${pct(p.y)} from top)${p.note.trim() ? `: ${p.note.trim()}` : ""}`);
}

function verdictWord(d: Draft): string {
  return d.verdict === "approve" ? "✓ Approved" : d.verdict === "reject" ? "✗ Rejected" : d.comment?.trim() || d.pins.length ? "Comment" : "No verdict";
}

/** The one reply a gallery review sends: per image its verdict, comment and pins, with the path. */
export function reviewReply(items: { path: string; caption?: string }[], drafts: Draft[]): string {
  const lines = [`Image review (${items.length} image${items.length === 1 ? "" : "s"}):`];
  items.forEach((it, i) => {
    const d = drafts[i] ?? EMPTY;
    const comment = d.comment?.trim();
    lines.push(`${i + 1}. ${verdictWord(d)} · ${it.caption?.trim() || nameOf(it.path)}${where(it.path)}${comment ? `: "${comment}"` : ""}`);
    lines.push(...pinLines(d.pins, "   "));
  });
  return lines.join("\n");
}

/** The reply a before/after review sends. Pins are on the after image. */
export function compareReply(before: string, after: string, d: Draft, pinsBefore: Pin[] = []): string {
  const comment = d.comment?.trim();
  const lines = [`Before/after review: ${verdictWord(d)} · ${nameOf(before)} → ${nameOf(after)}${/^data:/i.test(before + after) ? "" : ` (${before} → ${after})`}${comment ? `: "${comment}"` : ""}`];
  if (pinsBefore.length) lines.push("Pins on the before image:", ...pinLines(pinsBefore, ""));
  if (d.pins.length) lines.push("Pins on the after image:", ...pinLines(d.pins, ""));
  return lines.join("\n");
}

/** Pins on your own attachments, appended to the message so Claude knows where to look. */
export function attachmentNotes(files: { path: string; name: string }[], pinsOf: (path: string) => Pin[]): string {
  const parts = files.map((f) => ({ f, pins: pinsOf(f.path) })).filter((x) => x.pins.length);
  return parts.map(({ f, pins }) => [`Notes on ${f.name} (${f.path}):`, ...pinLines(pins, "")].join("\n")).join("\n\n");
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
