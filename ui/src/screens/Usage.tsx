import { useEffect, useState } from "react";
import { shortError } from "../components/ErrorLine";
import { flush, summarize, usageLabel, usageReport, type UsageRow } from "../state/usage";

// Settings → Usage (MR-83): which screens, buttons, shortcuts and actions you used, and what went quiet.

const RANGES: [string, number | null][] = [["7 days", 7], ["30 days", 30], ["All time", null]];
const TOP = 8;

export function Usage() {
  const [days, setDays] = useState<number | null>(7);
  const [rows, setRows] = useState<UsageRow[] | null>(null);
  const [all, setAll] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    flush();
    // Give the flushed batch a moment to land before reading.
    const t = setTimeout(() => usageReport(days === null ? 0 : Date.now() - days * 86_400_000).then(setRows).catch((e) => setErr(shortError(e))), 150);
    return () => clearTimeout(t);
  }, [days]);
  const s = rows && summarize(rows);
  return (
    <section data-mr="UsageSettings" style={{ padding: "0 16px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
      <div className="mr-row" style={{ gap: 12 }}>
        <h2 className="mr-h">Usage <span className="mr-dim" style={{ fontWeight: 400 }}>what you actually use, kept on this Mac</span></h2>
        <span className="mr-grow" />
        <div role="radiogroup" aria-label="Usage range" className="mr-row" style={{ gap: 0, background: "var(--mr-well)", padding: 3 }}>
          {RANGES.map(([l, d]) => (
            <button key={l} type="button" role="radio" aria-checked={days === d} onClick={() => setDays(d)}
              style={{ border: 0, padding: "5px 12px", font: "inherit", cursor: "pointer", background: days === d ? "var(--mr-ink)" : "transparent", color: days === d ? "var(--mr-tile)" : "var(--mr-ink)" }}>{l}</button>
          ))}
        </div>
      </div>
      {err && <span style={{ color: "var(--mr-error)" }}>{err}</span>}
      {!s && !err && <span className="mr-dim">Counting…</span>}
      {s && s.total === 0 && <span className="mr-dim">Nothing recorded in this range yet. Use the app and come back.</span>}
      {s && s.total > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "var(--mr-gap)" }}>
          {s.groups.filter((g) => g.rows.length).map((g) => (
            <div key={g.kind} data-mr="UsageGroup" data-mr-source={g.kind} style={{ background: "var(--mr-well)", padding: 10, display: "flex", flexDirection: "column", gap: 4 }}>
              <strong>{g.title} <span className="mr-dim" style={{ fontWeight: 400 }}>{g.rows.length}</span></strong>
              {(all ? g.rows : g.rows.slice(0, TOP)).map((r) => <Bar key={`${r.name}|${r.detail}`} r={r} max={g.rows[0].count} />)}
            </div>
          ))}
        </div>
      )}
      {s && s.quiet.length > 0 && (
        <div data-mr="UsageQuiet" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <strong>Gone quiet <span className="mr-dim" style={{ fontWeight: 400 }}>used before, not in this range</span></strong>
          {(all ? s.quiet : s.quiet.slice(0, TOP)).map((r) => (
            <div key={`${r.kind}|${r.name}|${r.detail}`} className="mr-row" style={{ gap: 8, fontSize: 13 }}>
              <span className="mr-dim" style={{ width: 70 }}>{r.kind}</span>
              <span className="mr-grow mr-ellipsis">{usageLabel(r)}</span>
              <span className="mr-dim">last {new Date(r.last_at).toLocaleDateString()}</span>
            </div>
          ))}
        </div>
      )}
      {s && (s.groups.some((g) => g.rows.length > TOP) || s.quiet.length > TOP) && (
        <button type="button" className="mr-link" style={{ alignSelf: "flex-start" }} onClick={() => setAll((x) => !x)}>{all ? "Show top only" : "Show everything"}</button>
      )}
    </section>
  );
}

function Bar({ r, max }: { r: UsageRow; max: number }) {
  return (
    <div className="mr-row" style={{ gap: 8, fontSize: 13 }} title={`${r.count} in range · ${r.total} all time`}>
      <span className="mr-ellipsis" style={{ flex: "0 0 55%" }}>{usageLabel(r)}</span>
      <span className="mr-grow" style={{ height: 6, background: "var(--mr-tile)" }}><i style={{ display: "block", height: "100%", width: `${Math.max(4, (r.count / max) * 100)}%`, background: "var(--mr-ink-3)" }} /></span>
      <span className="mr-mono" style={{ width: 40, textAlign: "right" }}>{r.count}</span>
    </div>
  );
}
