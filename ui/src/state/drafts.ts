import { useCallback, useSyncExternalStore } from "react";

// What you've typed but not sent yet, kept per box (a session's message box, a reply, a note), so
// switching sessions, tabs or workspaces, or an Update restart, never loses it. In memory for
// every render, mirrored to localStorage; an emptied draft (sent, cleared) is forgotten.

const PREFIX = "mr.draft.";
const mem = new Map<string, unknown>();
const subs = new Set<() => void>();
const subscribe = (f: () => void) => { subs.add(f); return () => void subs.delete(f); };

const blank = (v: unknown) => v === "" || v == null || (Array.isArray(v) && !v.length) || (typeof v === "object" && !Array.isArray(v) && !Object.keys(v as object).length);

export function readDraft<T>(key: string, empty: T): T {
  if (!mem.has(key)) {
    let v: unknown = empty;
    try { const raw = localStorage.getItem(PREFIX + key); if (raw != null) v = JSON.parse(raw); } catch { /* convenience only */ }
    mem.set(key, v);
  }
  return mem.get(key) as T;
}

export function writeDraft<T>(key: string, v: T) {
  mem.set(key, v);
  try { if (blank(v)) localStorage.removeItem(PREFIX + key); else localStorage.setItem(PREFIX + key, JSON.stringify(v)); } catch { /* convenience only */ }
  subs.forEach((f) => f());
}

type Setter<T> = (v: T | ((prev: T) => T)) => void;

/** A draft value for this key, like useState but surviving unmounts (and restarts). */
export function useDraftValue<T>(key: string, empty: T): [T, Setter<T>] {
  const snap = () => readDraft(key, empty);
  const v = useSyncExternalStore(subscribe, snap, snap);
  const set = useCallback<Setter<T>>((next) => writeDraft(key, typeof next === "function" ? (next as (p: T) => T)(readDraft(key, empty)) : next), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return [v, set];
}

/** A text draft: what's typed in one box. */
export const useDraft = (key: string) => useDraftValue<string>(key, "");
