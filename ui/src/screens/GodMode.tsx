import { shortError } from "../components/ErrorLine";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Key } from "../components";
import { api } from "../state/store";

// God mode (MR-22, ⌘⇧G): inspect why anything rendered the way it did, mark it wrong, and let a
// Claude Code session fix the app itself. Marks also become the eval set (evals/marks.jsonl).

type Target = { el: HTMLElement; component: string; source: string; layer: string; rect: DOMRect };

function findTarget(n: EventTarget | null): Target | null {
  const el = (n as HTMLElement | null)?.closest?.("[data-mr]") as HTMLElement | null;
  if (!el) return null;
  return { el, component: el.dataset.mr ?? "?", source: el.dataset.mrSource ?? "", layer: el.dataset.mrLayer ?? "code", rect: el.getBoundingClientRect() };
}

// A human name for the marked element: its first line of text, else its component name.
const label = (t: Target) => ((t.el.innerText ?? "").trim().split("\n")[0] || t.component).slice(0, 48);

// Right-click must work everywhere: elements without a data-mr tag fall back to the nearest
// meaningful container (button, heading, section, dialog…), and finally the whole screen.
function anyTarget(n: EventTarget | null): Target {
  const tagged = findTarget(n);
  if (tagged) return tagged;
  const start = n as HTMLElement | null;
  const el = (start?.closest?.("button, a, h1, h2, h3, li, header, section, main, aside, [role=dialog], [role=listbox], [role=menu], figure, form") as HTMLElement | null) ?? document.body;
  const name = el.getAttribute("aria-label") ?? el.querySelector("h1, h2, strong")?.textContent ?? (el.innerText ?? "").trim().split("\n")[0];
  const component = el === document.body ? "Screen" : `${el.getAttribute("role") ?? el.tagName.toLowerCase()}${name ? ` “${name.slice(0, 32)}”` : ""}`;
  return { el, component, source: "", layer: "untagged", rect: el.getBoundingClientRect() };
}

export function GodMode({ on, onOpen, onClose, view, onOpenSession, sessionAction }: { on: boolean; onOpen: () => void; onClose: () => void; view: string; onOpenSession: (id: string) => void; sessionAction?: (source: string, component: string) => { label: string; run: () => void } | null }) {
  const [hover, setHover] = useState<Target | null>(null);
  const [marked, setMarked] = useState<Target | null>(null);
  const [note, setNote] = useState("");
  const [status, setStatus] = useState("");
  // Right-click anything: a small menu to mark it wrong, inspect it, go deeper or discover.
  const [menu, setMenu] = useState<{ x: number; y: number; t: Target; origin: HTMLElement } | null>(null);

  useEffect(() => {
    const ctx = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      // Text fields and the terminal keep the native menu (copy, paste, spelling).
      if (el?.closest?.("input, textarea, [contenteditable=true], .xterm, [data-mr-menu]")) return;
      const t = anyTarget(el);
      e.preventDefault();
      setMenu({ x: Math.min(e.clientX, window.innerWidth - 240), y: Math.min(e.clientY, window.innerHeight - 190), t, origin: el! });
    };
    const close = (e: Event) => { if (!(e.target as HTMLElement | null)?.closest?.("[data-mr-menu]")) setMenu(null); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(null); };
    // "Report a bug" without pointing (Settings, the wall footer, an error panel): mark the screen.
    const report = (e: Event) => { const el = (e as CustomEvent<HTMLElement | undefined>).detail ?? document.body; onOpen(); setHover(null); setMarked(anyTarget(el)); };
    window.addEventListener("mr:report", report);
    window.addEventListener("contextmenu", ctx, true);
    window.addEventListener("mousedown", close, true);
    window.addEventListener("keydown", esc, true);
    window.addEventListener("scroll", close, true);
    return () => { window.removeEventListener("mr:report", report); window.removeEventListener("contextmenu", ctx, true); window.removeEventListener("mousedown", close, true); window.removeEventListener("keydown", esc, true); window.removeEventListener("scroll", close, true); };
  }, []);

  useEffect(() => {
    if (!on) { setHover(null); setMarked(null); return; }
    const move = (e: MouseEvent) => { if (!marked) setHover(anyTarget(e.target)); };
    const click = (e: MouseEvent) => {
      if ((e.target as HTMLElement)?.closest?.("[data-godmode-ui]")) return;
      const t = anyTarget(e.target);
      e.preventDefault(); e.stopPropagation();
      setMarked(t); setHover(null);
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); if (marked) setMarked(null); else onClose(); } };
    window.addEventListener("mousemove", move, true);
    window.addEventListener("click", click, true);
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("mousemove", move, true); window.removeEventListener("click", click, true); window.removeEventListener("keydown", key, true); };
  }, [on, marked, onClose]);

  const click = (origin: HTMLElement, mods: { metaKey?: boolean; altKey?: boolean }) => origin.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...mods }));
  const menuEl = menu && (
    <div data-mr-menu data-godmode-ui role="menu" className="mr-pop" aria-label={`Actions for ${menu.t.component}`}
      style={{ position: "fixed", left: menu.x, top: menu.y, zIndex: 60, width: 232, background: "var(--mr-tile)", boxShadow: "0 0 0 1px var(--mr-ink-3), 0 6px 18px rgba(21,24,27,.18)", display: "flex", flexDirection: "column", padding: 4 }}>
      <span className="mr-mono mr-dim mr-ellipsis" style={{ fontSize: 11, padding: "4px 8px" }}>{menu.t.component} · layer {menu.t.layer}{menu.t.source ? ` · ${menu.t.source.slice(0, 24)}` : ""}</span>
      {[
        { label: "Mark as wrong & fix…", hint: "", run: () => { onOpen(); setHover(null); setMarked({ ...menu.t, rect: menu.t.el.getBoundingClientRect() }); } },
        { label: "Go deeper", hint: "⌘-click", run: () => click(menu.origin, { metaKey: true }) },
        { label: "Discover in a side session", hint: "⌥-click", run: () => click(menu.origin, { altKey: true }) },
        { label: "Inspect everything", hint: "⌘⇧G", run: () => onOpen() },
        ...(() => { const a = menu.t.source ? sessionAction?.(menu.t.source, menu.t.component) : null; return a ? [{ label: a.label, hint: "", run: a.run }] : []; })(),
      ].map((it) => (
        <button key={it.label} type="button" role="menuitem" className="mr-row" onClick={() => { setMenu(null); it.run(); }}
          style={{ border: 0, background: "transparent", font: "inherit", color: "var(--mr-ink)", textAlign: "left", padding: "7px 8px", cursor: "pointer" }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--mr-well)")} onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
          <span className="mr-grow">{it.label}</span>{it.hint && <span className="mr-mono mr-dim" style={{ fontSize: 11 }}>{it.hint}</span>}
        </button>
      ))}
    </div>
  );

  if (!on) return menuEl || null;
  const box = (marked ?? hover)?.rect;

  const submit = async () => {
    if (!marked || !note.trim()) return;
    const packet = {
      note: note.trim(), component: marked.component, source: marked.source, layer: marked.layer, view,
      text: (marked.el.innerText ?? "").slice(0, 600), html: marked.el.outerHTML.slice(0, 3000), at: new Date().toISOString(),
    };
    setStatus("Saving the mark…");
    try {
      const repo = await invoke<string>("godmode_save_mark", { packet });
      const id = await api.start(repo, `God-mode mark on Cockpit (this app's own repo). The user marked the "${packet.component}" component as wrong in the ${view} view.\n\nTheir note: ${packet.note}\n\nWhat it showed: ${packet.text}\nSource: ${packet.source} · picker layer: ${packet.layer}\nRendered HTML (trimmed): ${packet.html}\n\nFind why it rendered that way (component in ui/src/components or ui/src/screens, picker in ui/src/picker, or state in ui/src/state), fix it, and add a regression test (vitest, next to the code) built from this packet. The packet is also the last line of evals/marks.jsonl. Run \`cd ui && bun run test && bun run build\`. Keep the fix small. When the tests pass, commit it on this branch as one commit titled "Fix: <what you fixed>"; the user applies it to their app from here.`, "blank", true);
      setStatus("");
      setMarked(null); setNote(""); onClose();
      onOpenSession(id);
    } catch (e) { setStatus(shortError(e)); }
  };

  return (
    <>{menuEl}
    <div data-godmode-ui style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 50 }}>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, padding: "6px 16px", background: "var(--mr-ink)", color: "var(--mr-tile)", display: "flex", gap: 16, pointerEvents: "auto" }}>
        <strong>God mode</strong><span style={{ opacity: 0.8 }}>Hover to inspect · click (or right-click anywhere, any time) to mark it wrong · esc to leave</span>
      </div>
      {box && <div style={{ position: "absolute", left: box.left, top: box.top, width: box.width, height: box.height, outline: `2px solid ${marked ? "var(--mr-error)" : "var(--mr-selected)"}`, background: "rgba(14,110,120,.06)" }} />}
      {hover && !marked && box && (
        <div className="mr-mono" style={{ position: "absolute", left: box.left, top: Math.max(30, box.top - 26), padding: "2px 8px", background: "var(--mr-selected)", color: "var(--mr-tile)", fontSize: 12 }}>
          {hover.component} · layer {hover.layer}{hover.source ? ` · ${hover.source.slice(0, 40)}` : ""}
        </div>
      )}
      {marked && (
        <div data-godmode-ui style={{ position: "absolute", ...(marked.rect.left + marked.rect.width / 2 > window.innerWidth / 2 ? { left: 16 } : { right: 16 }), bottom: 16, width: 420, padding: 16, background: "var(--mr-tile)", display: "flex", flexDirection: "column", gap: 10, pointerEvents: "auto", boxShadow: "0 0 0 2px var(--mr-error)" }}>
          {/* Opposite side from the marked element, so you can still see what you're describing. */}
          <strong>What's wrong with “{label(marked)}”?</strong>
          <span className="mr-mono mr-dim" style={{ fontSize: 12 }}>{marked.component} · {view}{marked.source ? ` · ${marked.source.slice(0, 24)}` : ""}</span>
          <textarea autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="What's wrong, and what should it show instead?" rows={4} className="mr-input" style={{ padding: 10, minHeight: 90, resize: "vertical" }}
            onKeyDown={(e) => { if (e.key === "Enter" && e.metaKey) { e.preventDefault(); void submit(); } }} />
          <div className="mr-row">
            <Key k="⌘↵" tone="primary" onClick={() => void submit()} disabled={!note.trim()}>Save mark and fix it</Key>
            <Key k="esc" onClick={() => setMarked(null)}>Cancel</Key>
          </div>
          <span className="mr-dim" style={{ fontSize: 12 }}>Saved to evals/marks.jsonl; a session on the app's own repo (new worktree) fixes it and adds a regression test.</span>
          {status && <span style={{ color: status.startsWith("Saving") ? "var(--mr-ink-2)" : "var(--mr-error)" }}>{status}</span>}
        </div>
      )}
    </div>
    </>
  );
}
