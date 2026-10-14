import { useLayoutEffect, type RefObject } from "react";

// A prompt box grows with what's typed or pasted, then scrolls past a cap (`max` px, and never
// more than 40% of the window), so a long paste shows itself instead of hiding in one line.
// The height eases (motion.css): it's measured on an offscreen twin, because collapsing the real
// box to read its scrollHeight would restart the transition from `auto` and make it snap.
export function useAutoGrow(ref: RefObject<HTMLTextAreaElement | null>, value: string, max = 320) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let follow = 0;
    const fit = (animate: boolean) => {
      const cap = Math.min(max, Math.round(window.innerHeight * 0.4));
      const content = measure(el);
      const next = Math.min(content, cap);
      const prev = el.getBoundingClientRect().height;
      el.style.overflowY = content > cap ? "auto" : "hidden";
      if (Math.abs(next - prev) < 1) return;
      // While it grows into room it has, the text unrolls from the top instead of jumping to the caret.
      if (content <= cap) el.scrollTop = 0;
      if (!animate) el.style.transition = "none";
      el.style.height = `${next}px`;
      if (!animate) { void el.offsetHeight; el.style.transition = ""; }
      // Keep the box's bottom on screen while it grows, so the line being typed never slides out of view.
      if (next > prev && document.activeElement === el) {
        const until = performance.now() + 260;
        const step = () => { el.scrollIntoView({ block: "nearest" }); if (performance.now() < until) follow = requestAnimationFrame(step); };
        cancelAnimationFrame(follow);
        follow = requestAnimationFrame(step);
      }
    };
    fit(el.style.height !== "");
    // A wider or narrower box rewraps its lines: refit without animating.
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => { if (el.clientWidth !== width) { width = el.clientWidth; fit(false); } });
    ro.observe(el);
    return () => { ro.disconnect(); cancelAnimationFrame(follow); };
  }, [ref, value, max]);
}

// One hidden textarea shared by every prompt box, styled like the box it measures.
let twin: HTMLTextAreaElement | null = null;
const COPY = ["boxSizing", "fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing", "wordSpacing", "textTransform", "textIndent",
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderBottomWidth", "borderLeftWidth", "borderRightWidth",
  "whiteSpace", "wordBreak", "overflowWrap", "tabSize", "minHeight"] as const;
function measure(el: HTMLTextAreaElement): number {
  if (!twin) {
    twin = document.createElement("textarea");
    twin.setAttribute("aria-hidden", "true");
    twin.tabIndex = -1;
    Object.assign(twin.style, { position: "absolute", top: "0", left: "-9999px", visibility: "hidden", pointerEvents: "none", overflow: "hidden", height: "auto", maxHeight: "none", transition: "none" });
    document.body.appendChild(twin);
  }
  const cs = getComputedStyle(el);
  for (const k of COPY) twin.style[k] = cs[k];
  twin.style.width = `${el.getBoundingClientRect().width}px`;
  twin.rows = el.rows;
  twin.value = el.value || el.placeholder;
  return twin.scrollHeight;
}

// ↵ sends, ⇧↵ adds a line; never mid-IME composition.
export const sendsOnEnter = (e: React.KeyboardEvent) => e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing;
