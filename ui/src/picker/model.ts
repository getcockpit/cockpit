import type { ModelRow, SessionState } from "../state/types";

// "claude-opus-5-5[1m]" → "Opus 5.5 · 1M context"; anything else is shown as it is.
export function prettyModel(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i.exec(id);
  if (!m) return id;
  const name = m[1][0].toUpperCase() + m[1].slice(1);
  return `${name} ${m[2]}${m[3] ? `.${m[3]}` : ""}${m[4] ? " · 1M context" : ""}`;
}

// The picker row the session runs on: your pick, else the row that resolves to what Claude Code reports.
export function currentRow(s: Pick<SessionState, "model" | "modelChoice">, models: ModelRow[]): ModelRow | null {
  if (s.modelChoice) return models.find((r) => r.value === s.modelChoice) ?? null;
  // No pick means Claude Code's default; another row only when the default row resolves elsewhere.
  const bare = s.model?.replace(/\[1m\]$/i, "");
  const runs = (r: ModelRow) => !!r.resolved && (r.resolved === s.model || r.resolved === bare);
  const def = models.find((r) => r.value === "default") ?? null;
  return def && (!s.model || runs(def)) ? def : models.find(runs) ?? def;
}

// What the chip says: the model by name and the effort it runs at.
export function modelLabel(s: Pick<SessionState, "model" | "modelChoice" | "effort">, models: ModelRow[]): { model: string; effort: string } {
  const row = s.modelChoice ? currentRow(s, models) : null;
  const model = row?.displayName ?? (s.modelChoice ? prettyModel(s.modelChoice) : s.model ? prettyModel(s.model) : "Default model");
  return { model, effort: s.effort ?? "default effort" };
}
