import { useEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";

// Motion helpers (MR-67). The CSS lives in design/motion.css; these two cover what CSS can't:
// animating something out before React removes it, and morphing one screen into the next.

export const EXIT_MS = 140; // --mr-exit

const still = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// Keeps an overlay on screen for its exit animation after `show` turns false. While leaving it
// renders the last children it saw, marked .mr-leaving so .mr-scrim/.mr-sheet play backwards.
export function Presence({ show, children }: { show: boolean; children: ReactNode }) {
  const last = useRef(children);
  if (show) last.current = children;
  const [mounted, setMounted] = useState(show);
  useEffect(() => {
    if (show) { setMounted(true); return; }
    const t = setTimeout(() => setMounted(false), still() ? 0 : EXIT_MS);
    return () => clearTimeout(t);
  }, [show]);
  if (!show && !mounted) return null;
  return <div className={show ? undefined : "mr-leaving"} style={{ display: "contents" }}>{show ? children : last.current}</div>;
}

export type Nav = "deeper" | "back" | "side";

type Transition = { ready: Promise<void>; finished: Promise<void>; updateCallbackDone: Promise<void> };
type VTDocument = Document & { startViewTransition?: (update: () => void) => Transition };
let queued: { run: () => void; dir: Nav }[] | null = null;

// Runs a screen change inside a view transition, so the old screen recedes and the new one
// arrives. Calls made in the same tick share one transition; the last one sets the direction.
export function navigate(dir: Nav, update: () => void) {
  const doc = document as VTDocument;
  if (!doc.startViewTransition || still()) { update(); return; }
  if (queued) { queued.push({ run: update, dir }); return; }
  queued = [{ run: update, dir }];
  const t = doc.startViewTransition(() => {
    const q = queued ?? [];
    queued = null;
    document.documentElement.dataset.nav = q.at(-1)?.dir ?? dir;
    flushSync(() => q.forEach((x) => x.run()));
  });
  // A skipped transition (window hidden, another one started) still applies the update; it only
  // rejects these promises, which is not an error here.
  for (const p of [t.ready, t.finished, t.updateCallbackDone]) p.catch(() => {});
}
