// Slow lookups shared across screens (MR-57): the wall remounts on every workspace switch, so its
// PR suggestions, daily count and the app's repo path are cached here and refreshed in the
// background instead of being fetched again (each costs 0.5–2 s of gh or disk work).
type Entry<T> = { at: number; value: T | undefined; pending: Promise<T> | null };
const entries = new Map<string, Entry<unknown>>();

/** The cached value right away (or undefined), refreshed in the background once older than ttl. */
export function cached<T>(key: string, ttlMs: number, load: () => Promise<T>, onValue: (v: T) => void): T | undefined {
  const e = (entries.get(key) as Entry<T> | undefined) ?? { at: 0, value: undefined, pending: null };
  entries.set(key, e);
  if (!e.pending && Date.now() - e.at > ttlMs) {
    e.pending = load().then((v) => { e.value = v; e.at = Date.now(); return v; }).finally(() => { e.pending = null; });
  }
  e.pending?.then(onValue).catch(() => {});
  return e.value;
}
