import { modKey } from "../platform";

// Universal pointing (decision 21): the same modifiers mean the same thing on every element.
// click = open/select, ⌘-click = go deeper, ⌥-click = discover in a side session (Ctrl / Alt off a Mac).
export type PointHandlers = { open?: () => void; deeper?: () => void; discover?: () => void };

export function pointer(h: PointHandlers) {
  return (e: React.MouseEvent) => {
    if (modKey(e) && h.deeper) { e.preventDefault(); e.stopPropagation(); h.deeper(); return; }
    if (e.altKey && h.discover) { e.preventDefault(); e.stopPropagation(); h.discover(); return; }
    h.open?.();
  };
}
