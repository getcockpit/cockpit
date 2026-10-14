import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { keyLabel, modKey } from "../platform";

// Feature usage (MR-83): which buttons, views and shortcuts you actually use, so unused features
// can go. One capture-phase listener reads the data-mr tags every element already carries; batches
// go to the core's own `usage` table (not the replayed event log). Local only.

export type UsageItem = { kind: "click" | "view" | "key"; name: string; detail: string; view: string; at: number };
export type UsageRow = { kind: "click" | "view" | "key" | "action"; name: string; detail: string; count: number; total: number; last_at: number };

let buffer: UsageItem[] = [];
let currentView = "";

export function track(kind: UsageItem["kind"], name: string, detail = "") {
  buffer.push({ kind, name, detail, view: currentView, at: Date.now() });
  if (buffer.length >= 50) flush();
}

export function flush() {
  if (!buffer.length) return;
  const items = buffer;
  buffer = [];
  void invoke("usage_track", { items }).catch(() => {});
}

/** A button's own words, without its shortcut chip; numbers become # so "3 sessions" counts as one. */
export function labelOf(el: Element): string {
  const aria = el.getAttribute("aria-label") ?? el.getAttribute("title");
  let text = aria ?? "";
  if (!aria) el.childNodes.forEach((n) => { if (!(n instanceof HTMLElement && n.tagName === "KBD")) text += n.textContent ?? ""; });
  text = text.replace(/(?:[⌘⌥⇧⌃]+|\b(?:Ctrl|Alt|Shift)[+-])\S*/g, "").replace(/\s+/g, " ").trim().replace(/\d+/g, "#");
  // Long text is content (a session title, a PR), not a feature name.
  return text.length > 40 ? "" : text;
}

/** What a click hit: the nearest data-mr component plus the button's label, or null for blank space. */
export function describe(target: Element | null): { name: string; detail: string } | null {
  if (!target) return null;
  const control = target.closest('button, a, input, select, textarea, summary, [role="button"], [role="radio"], [role="tab"], [role="menuitem"], [role="option"], [role="checkbox"]');
  const tagged = target.closest("[data-mr]");
  if (!control && !tagged) return null;
  const name = tagged?.getAttribute("data-mr") ?? control!.tagName.toLowerCase();
  const detail = control ? labelOf(control) || (control.getAttribute("placeholder") ?? "").slice(0, 40) : "";
  return { name, detail };
}

/** "⌘⇧K" for shortcuts; null for plain typing. The command key is ⌘ on every platform (Ctrl off a Mac). */
export function comboOf(e: { metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; code: string; key: string }, typing: boolean): string | null {
  if (!e.metaKey && !e.ctrlKey) return null;
  const k = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3) : /^Digit\d$/.test(e.code) ? e.code.slice(5) : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (/^(Meta|Control|Alt|Shift|OS)/.test(e.key) || /^(Meta|Control|Alt|Shift|OS)/.test(e.code)) return null;
  // Copy, paste, undo and select-all while typing are editing, not features.
  const cmd = modKey(e);
  if (typing && cmd && !e.shiftKey && !e.altKey && "CVXZA".includes(k) && k.length === 1) return null;
  return `${e.ctrlKey && !cmd ? "⌃" : ""}${e.altKey ? "⌥" : ""}${e.shiftKey ? "⇧" : ""}${cmd ? "⌘" : ""}${k}`;
}

export function installUsage(): () => void {
  const onClick = (e: MouseEvent) => {
    const hit = describe(e.target instanceof Element ? e.target : null);
    if (hit) track("click", hit.name, `${e.type === "contextmenu" ? "right-click " : modKey(e) ? "⌘ " : e.altKey ? "⌥ " : ""}${hit.detail}`.trim());
  };
  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    const typing = !!t && (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t.isContentEditable);
    const combo = comboOf(e, typing);
    if (combo) track("key", combo);
  };
  const timer = window.setInterval(flush, 5000);
  window.addEventListener("click", onClick, true);
  window.addEventListener("contextmenu", onClick, true);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("pagehide", flush);
  return () => {
    flush();
    window.clearInterval(timer);
    window.removeEventListener("click", onClick, true);
    window.removeEventListener("contextmenu", onClick, true);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("pagehide", flush);
  };
}

/** Logs each screen or overlay when it opens; the first name is the main screen, used as the click's context. */
export function useViews(open: string[]) {
  const prev = useRef<string[]>([]);
  const key = open.join("|");
  useEffect(() => {
    currentView = open[0] ?? "";
    for (const v of open) if (!prev.current.includes(v)) track("view", v);
    prev.current = open;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

export const usageReport = (since: number) => invoke<UsageRow[]>("usage_report", { since });

export type UsageSummary = { groups: { kind: UsageRow["kind"]; title: string; rows: UsageRow[] }[]; quiet: UsageRow[]; total: number };

const GROUPS: [UsageRow["kind"], string][] = [["view", "Screens"], ["click", "Buttons"], ["key", "Shortcuts"], ["action", "Actions"]];

/** Rows used in the window, per kind and most used first; the rest went quiet (used before, not since). */
export function summarize(rows: UsageRow[]): UsageSummary {
  const used = rows.filter((r) => r.count > 0).sort((a, b) => b.count - a.count);
  return {
    groups: GROUPS.map(([kind, title]) => ({ kind, title, rows: used.filter((r) => r.kind === kind) })),
    quiet: rows.filter((r) => r.count === 0).sort((a, b) => b.total - a.total),
    total: used.reduce((n, r) => n + r.count, 0),
  };
}

export const usageLabel = (r: UsageRow) => keyLabel(r.kind === "click" ? (r.detail ? `${r.detail} · ${r.name}` : r.name) : r.kind === "action" ? r.name.replace(/_/g, " ") : r.name);
