import { useSyncExternalStore } from "react";
import { api } from "../state/store";
import type { SessionState } from "../state/types";

// Drag a Wall tile onto a workspace tab to move the session there (MR-156). Pointer events, not
// HTML5 drag: the webview's file drop takes those (as with the tab reorder, MR-84). A ghost follows
// the pointer; the tab under it lights up; letting go there moves it like the header button does.
export type SessionDrag = { session: string; title: string; from: string; x: number; y: number; over: string | null };

let current: SessionDrag | null = null;
let justDragged = false;
const subs = new Set<() => void>();
const set = (d: SessionDrag | null) => { current = d; subs.forEach((f) => f()); };
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

/** The drag in progress, if any (the tab bar and the ghost read it). */
export const useSessionDrag = () => useSyncExternalStore(subscribe, () => current);

/** Which workspace tab is under a point; the ghost doesn't catch the pointer, so it never hides one. */
export function tabAt(x: number, y: number): string | null {
  const el = typeof document.elementFromPoint === "function" ? document.elementFromPoint(x, y) : null;
  return el?.closest('[data-mr="WorkspaceTab"]')?.getAttribute("data-mr-source") ?? null;
}

/** Pointer handlers for a draggable session. A press that doesn't travel stays a click. The rest of
 *  the drag listens on the window, so it follows the pointer anywhere, tabs included. */
export function dragSession(s: SessionState, title: string) {
  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0 || s.fromDeleted) return;
      const x0 = e.clientX, y0 = e.clientY;
      justDragged = false;
      const move = (ev: PointerEvent) => {
        if (!current && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
        set({ session: s.id, title, from: s.workspace, x: ev.clientX, y: ev.clientY, over: tabAt(ev.clientX, ev.clientY) });
      };
      const done = (ev: PointerEvent) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", done);
        window.removeEventListener("pointercancel", done);
        const d = current;
        if (!d) return;
        set(null);
        // The click that follows this release (same input event) isn't an open; a later one is.
        justDragged = true;
        setTimeout(() => { justDragged = false; }, 0);
        const to = ev.type === "pointerup" ? tabAt(ev.clientX, ev.clientY) : null;
        if (to && to !== d.from) {
          const name = document.querySelector(`[data-mr="WorkspaceTab"][data-mr-source="${CSS.escape(to)}"]`)?.getAttribute("data-mr-name") ?? "that workspace";
          void api.move(d.session, to)
            .then(() => window.dispatchEvent(new CustomEvent("mr:toast", { detail: `Moved to ${name}` })))
            .catch((err) => window.dispatchEvent(new CustomEvent("mr:toast", { detail: `Not moved: ${String(err).split("\n")[0]}` })));
        }
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", done);
      window.addEventListener("pointercancel", done);
    },
  };
}

/** True once, right after a drag ended: the tile's click handler skips opening it. */
export function consumeDrag(): boolean {
  const was = justDragged;
  justDragged = false;
  return was;
}

/** The ghost that follows the pointer while dragging a session. */
export function DragGhost() {
  const d = useSessionDrag();
  if (!d) return null;
  const hint = d.over && d.over !== d.from ? "Let go to move it here" : "Drop on a workspace tab";
  return (
    <div data-mr="SessionDragGhost" data-mr-source={d.session} aria-hidden
      style={{ position: "fixed", left: d.x + 12, top: d.y + 12, zIndex: 1000, pointerEvents: "none", maxWidth: 320, padding: "8px 12px", background: "var(--mr-tile)", boxShadow: "0 0 0 1px var(--mr-ink-3), 0 8px 24px rgba(21,24,27,.2)", display: "flex", flexDirection: "column", gap: 2 }}>
      <strong className="mr-ellipsis">{d.title}</strong>
      <span className="mr-dim" style={{ fontSize: 12 }}>{hint}</span>
    </div>
  );
}
