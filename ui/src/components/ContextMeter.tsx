import { api } from "../state/store";
import { contextFill } from "../state/reduce";
import type { SessionState } from "../state/types";

const k = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`);

// How much of the context a session has used, against where it auto-compacts, so you can
// compact on your own terms before it does. Amber from 80%; then a click sends /compact.
// slim: the Wall tile's read-only version (the tile is itself a button).
export function ContextMeter({ s, compactWindow, running, slim = false }: { s: SessionState; compactWindow: number | null; running: boolean; slim?: boolean }) {
  const fill = contextFill(s, compactWindow);
  if (!fill) return null;
  const high = fill.share >= 0.8;
  const pct = Math.min(100, Math.round(fill.share * 100));
  const canCompact = high && !running && !s.fromDeleted && !slim;
  const title = `Context: ${fill.used.toLocaleString()} of ${fill.limit.toLocaleString()} tokens before auto-compact`;
  const body = (
    <>
      {!slim && <span className="mr-dim">Context</span>}
      <span style={{ width: slim ? 32 : 48, height: 4, background: canCompact ? "var(--mr-base)" : "var(--mr-well)", display: "inline-block" }}><span style={{ display: "block", height: 4, width: `${pct}%`, background: high ? "var(--mr-needs)" : "var(--mr-ink-3)" }} /></span>
      <span className="mr-mono" style={{ color: high ? "var(--mr-needs-ink)" : "var(--mr-ink-2)", ...(slim && { fontSize: 12 }) }}>{k(fill.used)}/{k(fill.limit)}</span>
    </>
  );
  return canCompact
    ? <button type="button" className="mr-key" data-mr="ContextMeter" data-mr-source={s.id} style={{ gap: 6 }} title={`${title}. Click to compact now`} onClick={() => void api.send(s.id, "/compact")}>{body}<span style={{ color: "var(--mr-needs-ink)" }}>Compact</span></button>
    : <span className="mr-row" data-mr="ContextMeter" data-mr-source={s.id} style={{ gap: 6, flex: "none" }} title={title}>{body}</span>;
}
