import { keyOf } from "../components/keys";
import { useEffect, useMemo } from "react";
import { pointer } from "../components/pointer";
import { Key, StateMark } from "../components";
import { useTick } from "../components/Now";
import { CLOCK_TIMES, clock, forecast, headline, ordinal, soonest, typicalStep, type Forecast, type Upcoming } from "../picker/forecast";
import { pickTile, type TileSpec } from "../picker/pick";
import { needsQueue } from "../picker/queue";
import { plural, sessionTitle } from "../picker/title";
import type { Doc } from "../state/docs";
import type { AppState, SessionState, Span } from "../state/types";
import { inReviewTray, sideThread } from "./Wall";
import { ViewTabs } from "../components/ViewTabs";

// The Timeline (decision 29, MR-32): the wall is now, this is before and after. One lane per
// session over 30 minutes back and 15 ahead: solid = what happened (activity per minute, waits on
// you), dashed = predicted, shaded = the future. The header says when you're needed next.

const PAST = 30, AHEAD = 15, MIN = 60_000;
const X = (min: number) => ((min + PAST) / (PAST + AHEAD)) * 1000; // svg x for minutes from now
const pct = (min: number) => `${(X(Math.max(-PAST, Math.min(AHEAD, min))) / 10).toFixed(2)}%`;
const H = 44; // lane height in svg units

type Lane = { s: SessionState; tile: TileSpec; f: Forecast };

export function Timeline({ state, docs, onOpen, onOpenDoc, onWall }: { state: AppState; docs: Doc[]; onOpen: (id: string) => void; onOpenDoc: (id: string) => void; onWall: () => void }) {
  const now = useTick(true);
  const sessions = state.order.map((id) => state.sessions[id]);
  const queue = useMemo(() => needsQueue(sessions, docs), [sessions, docs]);
  // Forecasts move once a minute; the clock ticks every second for the Now line only.
  const minute = Math.floor(now / MIN);
  const lanes: Lane[] = useMemo(() => {
    const all = Object.values(state.sessions);
    return sessions.map((s) => ({ s, tile: pickTile(s), f: forecast(s, all, now, typicalStep(s, all)) }));
  }, [sessions, state.sessions, minute]); // eslint-disable-line react-hooks/exhaustive-deps
  const since = now - PAST * MIN;
  const recent = (s: SessionState) => (s.spans.at(-1)?.from ?? s.lastActivity) >= since || !inReviewTray(pickTile(s));
  const planned = lanes.filter((l) => l.s.todos.length > 0 && recent(l.s));
  const unplanned = lanes.filter((l) => l.s.todos.length === 0 && !inReviewTray(l.tile));
  const review = lanes.filter((l) => inReviewTray(l.tile));
  const upcoming: Upcoming[] = soonest(planned.flatMap((l) => (l.f.kind === "eta" ? [{ title: sessionTitle(l.s), f: l.f }] : [])));
  const rank = new Map(upcoming.map((u, i) => [u.f, i]));
  const top = queue[0];
  const handle = () => { if (!top) return; if (top.kind === "doc") onOpenDoc(top.d.id); else onOpen(top.s.id); };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || (e.target as HTMLElement)?.isContentEditable;
      if (typing || e.metaKey || e.ctrlKey || document.querySelector('[role="dialog"]')) return;
      if (keyOf(e) === "Enter" && top) { e.preventDefault(); handle(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const ticks = [-30, -20, -10, 0, 10]; // sparse, so labels never touch at narrow widths
  const topLabel = top ? (top.kind === "doc" ? top.d.title : sessionTitle(top.s)) : null;
  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100%" }}>
      <header className="mr-band mr-row" style={{ padding: "10px 24px", gap: 6 }}>
        <ViewTabs on="timeline" onSwitch={onWall} />
        <span className="mr-grow" />
        <span className="mr-mono mr-dim" style={{ fontSize: 12 }}>30 min back · 15 ahead</span>
      </header>

      <main style={{ flex: 1, display: "flex", flexDirection: "column", gap: 16, padding: "16px 24px 24px" }}>
        <section aria-label="Next 15 minutes" data-mr="TimelineSummary" data-mr-source="timeline" className="mr-row" style={{ background: "var(--mr-tile)", padding: "14px 16px", alignItems: "center" }}>
          <div className="mr-grow" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <h2 className="mr-h">Next 15 minutes</h2>
            <span style={{ fontSize: 16 }}>{headline(queue.length, upcoming, now)}</span>
          </div>
          {topLabel && <Key k="↵" tone="needs" onClick={handle}>Handle {topLabel.length > 32 ? `${topLabel.slice(0, 31)}…` : topLabel}</Key>}
        </section>

        {planned.length === 0 && unplanned.length === 0
          ? <p className="mr-dim" style={{ margin: 0 }}>Nothing ran in the last 30 minutes. Sessions show up here once they start.</p>
          : <section aria-label="Lanes" style={{ display: "flex", flexDirection: "column", gap: "var(--mr-gap)" }}>
            <div style={{ display: "grid", gridTemplateColumns: "200px 1fr 170px", gap: 12 }}>
              <span />
              <div style={{ position: "relative", height: 16 }} aria-hidden="true">
                {ticks.map((m) => <span key={m} className="mr-mono" style={{ position: "absolute", left: pct(m), transform: "translateX(-50%)", fontSize: 11, whiteSpace: "nowrap", color: m === 0 ? "var(--mr-ink)" : "var(--mr-ink-3)", fontWeight: m === 0 ? 700 : 400 }}>{m === 0 ? `Now · ${clock(now).slice(1)}` : `${m > 0 ? "+" : ""}${m} min`}</span>)}
              </div>
              <span />
            </div>
            {planned.map((l) => <LaneRow key={l.s.id} l={l} now={now} order={l.f.kind === "eta" ? rank.get(l.f) : undefined} onOpen={onOpen} />)}
            {unplanned.length > 0 && <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 8 }}>
              <h2 className="mr-h">No plan <span className="mr-dim" style={{ fontWeight: 400 }}>no forecast without one</span></h2>
              {unplanned.map((l) => (
                <button key={l.s.id} type="button" className="mr-row" data-mr="TimelineLine" data-mr-source={l.s.id} onClick={pointer({ open: () => onOpen(l.s.id), deeper: () => onOpen(l.s.id), discover: () => void sideThread(l.s).then(onOpen) })}
                  style={{ padding: "6px 12px", border: 0, background: "var(--mr-well)", font: "inherit", color: "inherit", cursor: "pointer", textAlign: "left" }}>
                  <StateMark s={l.tile.state} />
                  <strong className="mr-ellipsis" style={{ maxWidth: 260 }}>{sessionTitle(l.s)}</strong>
                  <span className="mr-grow mr-ellipsis mr-ink2">{l.tile.doing}</span>
                </button>
              ))}
            </div>}
          </section>}

        {review.length > 0 && (
          <section aria-label="Ready to review" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <h2 className="mr-h">Ready to review <span className="mr-dim">{review.length}</span></h2>
            <div className="mr-row" style={{ flexWrap: "wrap", gap: "var(--mr-gap)" }}>
              {review.map(({ s, tile }) => (
                <button key={s.id} type="button" className="mr-row" data-mr="ReviewRow" data-mr-source={s.id} onClick={() => onOpen(s.id)} style={{ gap: 8, padding: "6px 12px", border: 0, background: "var(--mr-well)", font: "inherit", color: "inherit", cursor: "pointer" }}>
                  <StateMark s={tile.state} /><span className="mr-ellipsis" style={{ maxWidth: 260 }}>{sessionTitle(s)}</span>
                  {Object.keys(s.files).length > 0 && <span className="mr-mono mr-dim" style={{ fontSize: 12 }}>{plural(Object.keys(s.files).length, "file")}</span>}
                </button>
              ))}
            </div>
          </section>
        )}
      </main>
      <footer className="mr-band mr-row mr-dim" style={{ padding: "8px 24px", fontSize: 12 }}>
        <span>Solid = what happened · dashed = predicted · shaded = the future</span>
        <span className="mr-grow" />
        {!CLOCK_TIMES && <span title="Forecasts show order, not times, until the backtest on your own history lands within ±3 min in 2 of 3 cases">Order only, not times: too little history yet</span>}
      </footer>
    </div>
  );
}

function LaneRow({ l, now, order, onOpen }: { l: Lane; now: number; order?: number; onOpen: (id: string) => void }) {
  const { s, tile, f } = l;
  const done = s.todos.filter((t) => t.status === "completed").length;
  // Activity: the session's 30 one-minute buckets end at the minute of its last event; minutes since
  // then were quiet. One point per minute of the window, the current minute ending at Now: window
  // minute k reads bucket k + quiet, and buckets past 29 (after the last event) are zero.
  const quiet = Math.floor(now / MIN) - Math.floor(s.lastActivity / MIN);
  const max = Math.max(1, ...s.activity);
  const perMin = Array.from({ length: PAST }, (_, k) => { const i = k + quiet; return i >= 0 && i < 30 ? s.activity[i] / max : 0; });
  const yOf = (v: number) => (H - 3 - v * (H - 8)).toFixed(1);
  const lastY = perMin[PAST - 1];
  const past = perMin.map((v, k) => `${X(k - PAST + 0.5).toFixed(1)},${yOf(v)}`).concat(`${X(0)},${yOf(lastY)}`).join(" ");
  // Future: paused stays flat; a forecast stop drops to zero (at its time, when times are shown).
  const future = f.kind === "paused" ? `${X(0)},${yOf(0)} 1000,${yOf(0)}`
    : f.kind === "eta" && CLOCK_TIMES ? (() => { const m = Math.min(AHEAD, (f.at - now) / MIN); return `${X(0)},${yOf(lastY)} ${X(m)},${yOf(lastY)} ${X(m)},${yOf(0)}${m < AHEAD ? ` 1000,${yOf(0)}` : ""}`; })()
    : f.kind === "eta" ? `${X(0)},${yOf(lastY)} 1000,${yOf(lastY)}` : null;
  const marks = s.spans.filter((x) => (x.to ?? now) >= now - PAST * MIN && ["needs_you", "ended", "error", "interrupted"].includes(x.status));
  const latest = marks.at(-1), earlier = marks.length - 1;
  const end = f.kind === "paused" ? { text: "Paused · needs you", color: "var(--mr-needs-ink)", weight: 700 }
    : f.kind === "eta" ? { text: CLOCK_TIMES ? `${f.label} ${clock(f.at)}` : `${ordinal(order ?? 0)} · ${f.label}`, color: f.ending === "needs" ? "var(--mr-needs-ink)" : "var(--mr-ink-2)", weight: 400 }
    : { text: f.label, color: "var(--mr-ink-3)", weight: 400 };
  return (
    <button type="button" data-mr="TimelineLane" data-mr-source={s.id} data-s={tile.state} aria-label={`${sessionTitle(s)}: ${end.text}`}
      onClick={pointer({ open: () => onOpen(s.id), deeper: () => onOpen(s.id), discover: () => void sideThread(s).then(onOpen) })}
      style={{ display: "grid", gridTemplateColumns: "200px 1fr 170px", gap: 12, alignItems: "center", padding: "8px 0 8px 12px", border: 0, background: "var(--mr-tile)", font: "inherit", color: "inherit", cursor: "pointer", textAlign: "left" }}>
      <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <strong className="mr-ellipsis" style={{ fontSize: 14 }}>{sessionTitle(s)}</strong>
        <span className="mr-mono mr-dim mr-ellipsis" style={{ fontSize: 11 }}>{done} of {s.todos.length} · {s.branch ?? s.cwd.split("/").pop()}</span>
      </span>
      <span style={{ position: "relative", height: H + 18 }}>
        <svg viewBox={`0 0 1000 ${H}`} preserveAspectRatio="none" width="100%" height={H} style={{ position: "absolute", top: 0, left: 0, display: "block" }} aria-hidden="true">
          <rect x={X(0)} y={0} width={1000 - X(0)} height={H} fill="var(--mr-well)" />
          {/* Every event is a mark (a wait: an amber bar; done, error, interrupted: a tick), its words on hover. */}
          {marks.map((x, i) => {
            const a = Math.max(-PAST, (x.from - now) / MIN), b = Math.min(0, ((x.to ?? now) - now) / MIN);
            return x.status === "needs_you"
              ? <rect key={i} x={X(a)} y={H - 4} width={Math.max(2, X(b) - X(a))} height={4} fill="var(--mr-needs)"><title>{markText(x)}</title></rect>
              : <line key={i} x1={X(a)} x2={X(a)} y1={H - 10} y2={H} stroke={markColor(x)} strokeWidth={2} vectorEffect="non-scaling-stroke"><title>{markText(x)}</title></line>;
          })}
          <polyline points={past} fill="none" stroke="var(--mr-ink-2)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
          {future && <polyline points={future} fill="none" stroke={f.kind === "paused" ? "var(--mr-needs-ink)" : "var(--mr-ink-3)"} strokeWidth={1.5} strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />}
          <line x1={X(0)} x2={X(0)} y1={0} y2={H} stroke="var(--mr-ink)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        </svg>
        {/* Only the latest mark gets words, so labels never pile up; near Now it reads leftwards. */}
        {latest && (() => {
          const m = Math.max(-PAST, (latest.from - now) / MIN), right = m > -PAST / 2;
          return <span data-mr="TimelineMark" data-mr-source={`${s.id}:${latest.status}:${latest.from}`} className="mr-ellipsis" style={{ position: "absolute", ...(right ? { right: `${(100 - X(m) / 10).toFixed(2)}%`, textAlign: "right" } : { left: pct(m) }), top: H + 2, maxWidth: "45%", fontSize: 11, color: markColor(latest), fontWeight: latest.status === "needs_you" && latest.to === null ? 700 : 400 }}>{markText(latest)}{earlier ? ` · ${earlier} earlier` : ""}</span>;
        })()}
        {f.kind === "eta" && CLOCK_TIMES && (f.at - now) / MIN <= AHEAD && (
          <span data-mr="TimelineMark" data-mr-source={`${s.id}:forecast`} style={{ position: "absolute", left: pct((f.at - now) / MIN), top: H + 2, fontSize: 11, color: f.ending === "needs" ? "var(--mr-needs-ink)" : "var(--mr-ink-2)" }}>{f.label}</span>
        )}
      </span>
      <span className="mr-ellipsis" style={{ fontSize: 13, color: end.color, fontWeight: end.weight, paddingRight: 12 }}>{end.text}</span>
    </button>
  );
}

const markText = (x: Span) => (x.status === "needs_you" ? `${x.to === null ? "Waiting" : "Waited"} on you${x.label ? ` · ${x.label}` : ""}` : x.status === "ended" ? "Done" : x.status === "error" ? "Error" : "Interrupted");
const markColor = (x: Span) => (x.status === "needs_you" ? "var(--mr-needs-ink)" : x.status === "ended" ? "var(--mr-done)" : x.status === "error" ? "var(--mr-error)" : "var(--mr-ink-3)");
