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

export function GodMode({ on, onClose, view, onOpenSession }: { on: boolean; onClose: () => void; view: string; onOpenSession: (id: string) => void }) {
  const [hover, setHover] = useState<Target | null>(null);
  const [marked, setMarked] = useState<Target | null>(null);
  const [note, setNote] = useState("");
  const [status, setStatus] = useState("");

  useEffect(() => {
    if (!on) { setHover(null); setMarked(null); return; }
    const move = (e: MouseEvent) => { if (!marked) setHover(findTarget(e.target)); };
    const click = (e: MouseEvent) => {
      if ((e.target as HTMLElement)?.closest?.("[data-godmode-ui]")) return;
      const t = findTarget(e.target);
      if (!t) return;
      e.preventDefault(); e.stopPropagation();
      setMarked(t); setHover(null);
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); if (marked) setMarked(null); else onClose(); } };
    window.addEventListener("mousemove", move, true);
    window.addEventListener("click", click, true);
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("mousemove", move, true); window.removeEventListener("click", click, true); window.removeEventListener("keydown", key, true); };
  }, [on, marked, onClose]);

  if (!on) return null;
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
      const id = await api.start(repo, `God-mode mark on Minority report (this app's own repo). The user marked the "${packet.component}" component as wrong in the ${view} view.\n\nTheir note: ${packet.note}\n\nWhat it showed: ${packet.text}\nSource: ${packet.source} · picker layer: ${packet.layer}\nRendered HTML (trimmed): ${packet.html}\n\nFind why it rendered that way (component in ui/src/components or ui/src/screens, picker in ui/src/picker, or state in ui/src/state), fix it, and add a regression test (vitest, next to the code) built from this packet. The packet is also the last line of evals/marks.jsonl. Run \`cd ui && bun run test && bun run build\`. Keep the fix small.`, "blank", true);
      setStatus("");
      setMarked(null); setNote(""); onClose();
      onOpenSession(id);
    } catch (e) { setStatus(String(e)); }
  };

  return (
    <div data-godmode-ui style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 50 }}>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, padding: "6px 16px", background: "var(--mr-ink)", color: "var(--mr-tile)", display: "flex", gap: 16, pointerEvents: "auto" }}>
        <strong>God mode</strong><span style={{ opacity: 0.8 }}>Hover to inspect · click to mark it wrong · esc to leave</span>
      </div>
      {box && <div style={{ position: "absolute", left: box.left, top: box.top, width: box.width, height: box.height, outline: `2px solid ${marked ? "var(--mr-error)" : "var(--mr-selected)"}`, background: "rgba(14,110,120,.06)" }} />}
      {hover && !marked && box && (
        <div className="mr-mono" style={{ position: "absolute", left: box.left, top: Math.max(30, box.top - 26), padding: "2px 8px", background: "var(--mr-selected)", color: "var(--mr-tile)", fontSize: 12 }}>
          {hover.component} · layer {hover.layer}{hover.source ? ` · ${hover.source.slice(0, 40)}` : ""}
        </div>
      )}
      {marked && (
        <div data-godmode-ui style={{ position: "absolute", right: 16, bottom: 16, width: 420, padding: 16, background: "var(--mr-tile)", display: "flex", flexDirection: "column", gap: 10, pointerEvents: "auto", boxShadow: "0 0 0 2px var(--mr-error)" }}>
          <strong>Mark “{marked.component}” as wrong</strong>
          <span className="mr-mono mr-dim" style={{ fontSize: 12 }}>layer {marked.layer} · {marked.source || "no source"} · {view}</span>
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
  );
}
