import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Key } from "../components";
import { CatalogView } from "../components/CatalogView";
import { pctText, reportBlocks, reportMarkdown, reportTitle, type PrReport, type ShareOpts } from "../state/prReport";

// The PR report for one repo (decision on q-report-home): numbers computed by the core from `gh`,
// no Claude usage. Shared as Markdown or a PNG, names and repo off unless turned on.

const WEEKS = [4, 8, 12];

function Sparkline({ opened, merged }: { opened: number[]; merged: number[] }) {
  const w = 240, h = 44, max = Math.max(1, ...opened, ...merged);
  const path = (xs: number[]) => xs.map((v, i) => `${i ? "L" : "M"}${(i / Math.max(1, xs.length - 1)) * (w - 4) + 2},${h - 2 - (v / max) * (h - 6)}`).join(" ");
  return (
    <svg data-mr="PrSparkline" width={w} height={h} role="img" aria-label={`PRs a week: opened ${opened.join(", ")}; merged ${merged.join(", ")}`}>
      <path d={path(opened)} fill="none" stroke="var(--mr-ink)" strokeWidth={2} />
      <path d={path(merged)} fill="none" stroke="var(--mr-ink-3)" strokeWidth={2} strokeDasharray="4 3" />
    </svg>
  );
}

const css = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

/** A shareable card: the headline numbers and the size table, drawn on a canvas. */
export async function reportPng(r: PrReport, o: ShareOpts): Promise<Blob | null> {
  const c = document.createElement("canvas");
  const s = 2, W = 960, H = 420;
  c.width = W * s; c.height = H * s;
  const g = c.getContext("2d");
  if (!g) return null;
  g.scale(s, s);
  const ink = css("--mr-ink", "#15181b"), dim = css("--mr-ink-3", "#6b7178"), tile = css("--mr-tile", "#ffffff"), well = css("--mr-well", "#eef0f2");
  const font = getComputedStyle(document.body).fontFamily || "sans-serif";
  g.fillStyle = tile; g.fillRect(0, 0, W, H);
  g.fillStyle = ink; g.font = `700 22px ${font}`; g.fillText(reportTitle(r, o), 32, 48);
  const stats: [string, string][] = [
    [(r.volume.opened_total / r.weeks).toFixed(1), "PRs a week"],
    [pctText(r.rates.approved_pct), "approved before merge"],
    [pctText(r.rates.changes_requested_pct), "got changes requested"],
    [pctText(r.rates.fixed_again_pct), "fixed again within 7 days"],
  ];
  stats.forEach(([v, l], i) => {
    const x = 32 + i * 228;
    g.fillStyle = well; g.fillRect(x, 72, 212, 104);
    g.fillStyle = ink; g.font = `700 40px ${font}`; g.fillText(v, x + 16, 126);
    g.fillStyle = dim; g.font = `15px ${font}`; g.fillText(l, x + 16, 158);
  });
  const cols = ["Size", "PRs", "Approved", "Changes req.", "Fixed again"], xs = [32, 300, 400, 540, 720];
  g.font = `700 15px ${font}`; g.fillStyle = dim;
  cols.forEach((t, i) => g.fillText(t, xs[i], 220));
  g.font = `16px ${font}`; g.fillStyle = ink;
  r.by_band.forEach((b, j) => {
    const y = 254 + j * 34;
    [b.band, String(b.rates.prs), pctText(b.rates.approved_pct), pctText(b.rates.changes_requested_pct), pctText(b.rates.fixed_again_pct)].forEach((t, i) => g.fillText(t, xs[i], y));
  });
  g.fillStyle = dim; g.font = `13px ${font}`;
  g.fillText("Fixed again: a merged fix or revert PR touching the same source files within a week. A loose signal.", 32, 384);
  g.fillText("Cockpit PR report", 32, 404);
  return await new Promise<Blob | null>((ok) => c.toBlob((b) => ok(b), "image/png"));
}

export function PrReportScreen({ repo, cwd, onClose }: { repo: string; cwd: string; onClose: () => void }) {
  const [weeks, setWeeks] = useState(8);
  const [r, setR] = useState<PrReport | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [opts, setOpts] = useState<ShareOpts>({ names: false, repo: false });
  const [msg, setMsg] = useState("");
  const load = () => {
    setLoading(true); setError("");
    invoke<PrReport>("pr_report", { cwd, repo, weeks })
      .then((x) => setR(x), (e) => setError(String(e).split("\n")[0]))
      .finally(() => setLoading(false));
  };
  useEffect(load, [repo, cwd, weeks]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!msg) return; const t = setTimeout(() => setMsg(""), 1800); return () => clearTimeout(t); }, [msg]);
  // On screen the names and repo are yours to see; the toggles only change what's shared.
  const blocks = useMemo(() => (r ? reportBlocks(r, { names: true, repo: true }) : []), [r]);
  const copyMd = () => r && navigator.clipboard.writeText(reportMarkdown(r, opts)).then(() => setMsg("Copied as Markdown"), () => setMsg("Can't copy"));
  const copyPng = async () => {
    if (!r) return;
    const b = await reportPng(r, opts);
    if (!b) return setMsg("Can't draw the image");
    await navigator.clipboard.write([new ClipboardItem({ "image/png": b })]).then(() => setMsg("Copied as an image"), () => setMsg("Can't copy"));
  };
  return (
    <div role="dialog" aria-label="PR report" className="mr-scrim" onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, display: "flex", justifyContent: "center", alignItems: "flex-start", padding: "56px 24px", background: "rgba(21,24,27,.35)", zIndex: 12, overflowY: "auto" }}>
      <div className="mr-sheet" data-mr="PrReport" data-mr-source={repo} style={{ width: "100%", maxWidth: 960, background: "var(--mr-band)", display: "flex", flexDirection: "column", gap: "var(--mr-gap)", padding: 16 }}>
        <div className="mr-row" style={{ gap: 10, flexWrap: "wrap" }}>
          <strong style={{ fontSize: 17 }}>PR report · <span className="mr-mono">{repo}</span></strong>
          <span className="mr-grow" />
          <div role="radiogroup" aria-label="Weeks" className="mr-row" style={{ gap: 4 }}>
            {WEEKS.map((w) => <Key key={w} pressed={w === weeks} onClick={() => setWeeks(w)}>{w} weeks</Key>)}
          </div>
          <Key onClick={load} disabled={loading}>{loading ? "Loading…" : "Refresh"}</Key>
          <Key k="esc" onClick={onClose}>Close</Key>
        </div>
        {error && <span style={{ color: "var(--mr-error)" }}>{error}</span>}
        {!r && loading && <span className="mr-dim">Reading the last {weeks} weeks of PRs through gh… the first run of a big repo takes a few seconds.</span>}
        {r && <>
          <div className="mr-row" style={{ gap: 16, padding: "8px 16px", background: "var(--mr-tile)" }}>
            <Sparkline opened={r.volume.opened} merged={r.volume.merged} />
            <span className="mr-dim">PRs a week, oldest first: <b>opened</b> (solid), merged (dashed)</span>
            <span className="mr-grow" />
            <span className="mr-dim">{r.fetched ? `${r.fetched} PRs fetched in ${(r.took_ms / 1000).toFixed(1)} s` : "Nothing new since the last run"}</span>
          </div>
          <CatalogView id={`pr-report:${repo}`} title="" blocks={blocks} onReply={() => {}} live={false} />
          {r.fixed_again.length > 0 && (
            <details data-mr="PrFixedAgain" data-mr-source={repo} style={{ padding: "8px 16px", background: "var(--mr-tile)" }}>
              <summary>{r.fixed_again.length === 1 ? "The PR" : `The ${r.fixed_again.length} PRs`} fixed again within 7 days</summary>
              <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
                {r.fixed_again.map((x) => <li key={x.pr}><a href={x.pr_url} target="_blank" rel="noreferrer">#{x.pr}</a>, fixed by <a href={x.fix_url} target="_blank" rel="noreferrer">#{x.fix}</a></li>)}
              </ul>
            </details>
          )}
          <div className="mr-row" data-mr="PrShare" data-mr-source={repo} style={{ gap: 12, padding: "8px 16px", background: "var(--mr-tile)", flexWrap: "wrap" }}>
            <strong>Share</strong>
            <label className="mr-row" style={{ gap: 6 }}><input type="checkbox" checked={opts.names} onChange={(e) => setOpts({ ...opts, names: e.target.checked })} />Include names</label>
            <label className="mr-row" style={{ gap: 6 }}><input type="checkbox" checked={opts.repo} onChange={(e) => setOpts({ ...opts, repo: e.target.checked })} />Include the repo</label>
            <span className="mr-grow" />
            {msg && <span className="mr-dim" role="status">{msg}</span>}
            <Key onClick={() => void copyMd()}>Copy Markdown</Key>
            <Key tone="primary" onClick={() => void copyPng()}>Copy image</Key>
          </div>
        </>}
      </div>
    </div>
  );
}
