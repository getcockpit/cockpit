import { modKey } from "../platform";

// Shortcuts match the physical key, not the typed character, so they work on any keyboard layout
// (with Ukrainian active, ⌘K types "л" and e.key never equals "k").
export function keyOf(e: { code: string; key: string }): string {
  const c = e.code;
  if (/^Key[A-Z]$/.test(c)) return c.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(c)) return c.slice(5);
  const named: Record<string, string> = { Comma: ",", Period: ".", Space: " ", Slash: "/" };
  return named[c] ?? e.key;
}

export type KeyEv = { code: string; key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; target: EventTarget | null };

/** The keyboard is someone's typing, not a shortcut: a text field or contentEditable has it. */
export function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || !!el.isContentEditable);
}

export type AppKey =
  | { do: "picker" | "god" | "settings" | "archive" | "update" | "builds" | "switcher" | "wallView" | "overview" }
  | { do: "workspace"; index: number }
  | { do: "cycle"; by: 1 | -1 };

/** The app-wide shortcuts (App.tsx), as one decision so each is unit-tested on both platforms.
 *  `dialog`: an overlay owns the keyboard; it blocks workspace switching and T, not ⌘K ⌘, ⌘J etc. */
export function appKey(e: KeyEv, at: { workspaces: number; screen: "wall" | "focus" | "doc" | "overview"; dialog: boolean }): AppKey | null {
  const k = keyOf(e), mod = modKey(e);
  if (mod && k === "k") return { do: "picker" };
  if (mod && e.shiftKey && k === "g") return { do: "god" };
  if (mod && k === ",") return { do: "settings" };
  if (mod && e.shiftKey && k === "a") return { do: "archive" };
  // ⌘⇧B updates the app from main (decision 27); ⌘⌥⇧B still opens the build history.
  if (mod && e.shiftKey && k === "b") return { do: e.altKey ? "builds" : "update" };
  // ⌘0: the Overview of every workspace (decision 40); again on it fits everything in view.
  if (mod && k === "0" && !e.shiftKey && !e.altKey) return at.dialog ? null : { do: "overview" };
  if (mod && /^[1-9]$/.test(k) && !e.shiftKey) return Number(k) <= at.workspaces && !at.dialog ? { do: "workspace", index: Number(k) - 1 } : null;
  // ⌃Tab / ⌃⇧Tab cycle workspaces like browser tabs; ⌘J opens the switcher (MR-55).
  if (e.ctrlKey && k === "Tab") return at.workspaces > 1 && !at.dialog ? { do: "cycle", by: e.shiftKey ? -1 : 1 } : null;
  if (mod && k === "j") return { do: "switcher" };
  // T switches Wall ↔ Timeline, only on those screens and never while typing.
  if (k === "t" && !e.metaKey && !e.ctrlKey && !e.altKey && !isTyping(e.target) && at.screen === "wall" && !at.dialog) return { do: "wallView" };
  return null;
}

export type OverviewKey = { do: "zoom"; by: number } | { do: "pan"; dx: number; dy: number } | { do: "back" };

/** The Overview canvas's own keys (decision 40): + and − zoom around the middle, arrows pan (⇧ pans
 *  further), Esc goes back to the workspace you came from. Never while typing, with an overlay open,
 *  or with ⌘/⌃ held (⌘0 and friends stay the app's). */
export function overviewKey(e: KeyEv, at: { dialog: boolean }): OverviewKey | null {
  if (at.dialog || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return null;
  const k = keyOf(e), step = e.shiftKey ? 400 : 80;
  if (k === "Escape") return { do: "back" };
  if (k === "+" || k === "=") return { do: "zoom", by: 1.25 };
  if (k === "-" || k === "_") return { do: "zoom", by: 1 / 1.25 };
  if (k === "ArrowLeft") return { do: "pan", dx: step, dy: 0 };
  if (k === "ArrowRight") return { do: "pan", dx: -step, dy: 0 };
  if (k === "ArrowUp") return { do: "pan", dx: 0, dy: step };
  if (k === "ArrowDown") return { do: "pan", dx: 0, dy: -step };
  return null;
}

export type FocusKey =
  | { do: "back" | "blur" | "interrupt" | "done" | "raw" | "model" | "catchUp" | "terminal" }
  | { do: "reply"; index: number };

/** A session's own shortcuts (Focus.tsx). Esc goes back even from a text field (the message box keeps
 *  focus after sending): an empty field goes straight back, one with a draft is only left, so the draft
 *  isn't lost to a stray Esc. The terminal keeps Esc for itself, and an open dialog closes first. */
export function focusKey(e: KeyEv & { defaultPrevented: boolean }, at: { running: boolean; archived: boolean; fromDeleted: boolean; replies: number; resumable: boolean; dialog: boolean }): FocusKey | null {
  const k = keyOf(e), mod = modKey(e);
  if (k === "Escape") {
    const el = e.target as (HTMLElement & { value?: string }) | null;
    if (e.defaultPrevented || at.dialog || el?.closest?.(".xterm")) return null;
    const field = el?.tagName === "INPUT" || el?.tagName === "TEXTAREA";
    return { do: field && el?.value ? "blur" : "back" };
  }
  if (k === "." && mod) return at.running ? { do: "interrupt" } : null;
  if (k === "d" && mod && e.shiftKey) return at.archived ? null : { do: "done" };
  if (e.altKey && /^[1-3]$/.test(k)) return !at.running && Number(k) <= at.replies ? { do: "reply", index: Number(k) - 1 } : null;
  if (k === "r" && mod) return { do: "raw" };
  if (k === "m" && mod && e.shiftKey) return at.fromDeleted ? null : { do: "model" };
  if (k === "u" && mod && e.shiftKey) return at.fromDeleted ? null : { do: "catchUp" };
  if (k === "t" && mod) return at.resumable ? { do: "terminal" } : null;
  return null;
}
