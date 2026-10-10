import { useEffect, useRef, useState } from "react";
import { keyOf } from "./keys";
import { api } from "../state/store";
import { currentRow, modelLabel } from "../picker/model";
import type { ModelRow, SessionState } from "../state/types";

const EFFORT_HINT: Record<string, string> = { low: "fastest, least thinking", medium: "balanced", high: "thinks harder", xhigh: "very hard problems", max: "no limit; this session only" };

// Which model a session runs and at what effort, and one click to change either (MR-73).
// A switch applies from Claude's next request; a stopped session takes it when it resumes.
export function ModelPicker({ s, models }: { s: SessionState; models: ModelRow[] }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const label = modelLabel(s, models);
  const row = currentRow(s, models);
  const efforts = row?.efforts ?? [];

  useEffect(() => {
    if (!open) return;
    if (!models.length) void api.modelsRefresh().catch(() => {});
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open, models.length]);

  const set = (change: { model?: string | null; effort?: string | null }) => void api.setModel(s.id, change).catch((e) => window.dispatchEvent(new CustomEvent("mr:toast", { detail: `Not switched: ${String(e).split("\n")[0]}` })));
  // Picking a model whose levels don't include your effort drops back to its default effort.
  const pickModel = (r: ModelRow) => set(s.effort && !r.efforts.includes(s.effort) ? { model: r.value === "default" ? null : r.value, effort: null } : { model: r.value === "default" ? null : r.value });

  return (
    <div ref={box} style={{ position: "relative" }} data-mr="ModelPicker" data-mr-source={s.id}>
      <button type="button" className="mr-key" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((x) => !x)} title={s.model ?? undefined}>
        <kbd>⌘⇧M</kbd>
        <span>{label.model}</span>
        <span className="mr-dim" style={{ fontWeight: 400 }}>· {label.effort}</span>
        {s.modelError && <span style={{ color: "var(--mr-error)" }} aria-label="Last switch failed">✕</span>}
        <span className="mr-dim" aria-hidden>▾</span>
      </button>
      {open && (
        <div role="dialog" aria-label="Model and effort" className="mr-pop"
          onKeyDown={(e) => { if (keyOf(e) === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); } }}
          style={{ position: "absolute", top: "calc(100% + 4px)", right: 0, width: 380, zIndex: 20, background: "var(--mr-tile)", boxShadow: "0 0 0 1px var(--mr-ink-3), 0 8px 24px rgba(21,24,27,.2)", display: "flex", flexDirection: "column", padding: "8px 0" }}>
          <span className="mr-dim" style={{ padding: "0 12px 6px", fontSize: 12 }}>Running: <span className="mr-mono">{s.model ?? "not started yet"}</span></span>
          {s.modelError && <span style={{ padding: "0 12px 6px", fontSize: 12, color: "var(--mr-error)" }} data-mr="ModelError" data-mr-source={s.id}>Not switched: {s.modelError}</span>}
          <div role="radiogroup" aria-label="Model" style={{ display: "flex", flexDirection: "column" }}>
            {models.length === 0 && <span className="mr-dim" style={{ padding: "6px 12px" }}>Asking Claude Code which models you have…</span>}
            {models.map((r) => {
              const on = row?.value === r.value;
              return (
                <button key={r.value} type="button" role="radio" aria-checked={on} onClick={() => pickModel(r)} data-mr="ModelRow" data-mr-source={r.value}
                  style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2, border: 0, padding: "7px 12px", font: "inherit", textAlign: "left", cursor: "pointer", color: "var(--mr-ink)", background: on ? "var(--mr-well)" : "transparent", boxShadow: on ? "inset 3px 0 0 var(--mr-selected)" : undefined }}>
                  <strong>{r.displayName}</strong>
                  <span className="mr-dim" style={{ fontSize: 12 }}>{r.description}</span>
                </button>
              );
            })}
          </div>
          <div style={{ padding: "10px 12px 4px", display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontWeight: 700 }}>Effort</span>
            {efforts.length === 0
              ? <span className="mr-dim" style={{ fontSize: 12 }}>{models.length ? "This model has no effort levels." : "—"}</span>
              : (
                <div role="radiogroup" aria-label="Effort" className="mr-row" style={{ gap: 4, flexWrap: "wrap" }}>
                  {[null, ...efforts].map((e) => (
                    <button key={e ?? "default"} type="button" role="radio" aria-checked={s.effort === e} className="mr-key" data-tone={s.effort === e ? "primary" : undefined}
                      style={{ minHeight: 30, padding: "0 10px" }} title={e ? EFFORT_HINT[e] : "the model's own default"} onClick={() => set({ effort: e })} data-mr="EffortLevel" data-mr-source={e ?? "default"}>
                      {e ?? "default"}
                    </button>
                  ))}
                </div>
              )}
            <span className="mr-dim" style={{ fontSize: 12 }}>{s.effort && EFFORT_HINT[s.effort] ? `${s.effort}: ${EFFORT_HINT[s.effort]}. ` : ""}Applies from Claude's next step.</span>
          </div>
        </div>
      )}
    </div>
  );
}
