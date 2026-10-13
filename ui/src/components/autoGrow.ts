import { useLayoutEffect, type RefObject } from "react";

// A prompt box grows with what's typed or pasted, up to `max` px, then scrolls (so a long paste
// shows itself instead of hiding in one line). Shrinks back when cleared.
export function useAutoGrow(ref: RefObject<HTMLTextAreaElement | null>, value: string, max = 320) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const h = Math.min(el.scrollHeight, max);
    el.style.height = `${h}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [ref, value, max]);
}

// ↵ sends, ⇧↵ adds a line; never mid-IME composition.
export const sendsOnEnter = (e: React.KeyboardEvent) => e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing;
