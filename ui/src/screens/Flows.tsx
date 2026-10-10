import { keyOf } from "../components/keys";
import { useEffect, useState } from "react";
import { Key, ProgressTrack } from "../components";
import { api } from "../state/store";
import type { SessionState } from "../state/types";

// Review (mirrors /review) and Address (mirrors pr-address), drawn from the flow.* steps Claude
// reports. User actions go back as the replies those commands already expect.

const SEV: Record<string, { color: string; bars: number }> = {
  critical: { color: "var(--mr-error)", bars: 4 }, important: { color: "var(--mr-needs-ink)", bars: 3 },
  suggestion: { color: "var(--mr-ink-2)", bars: 2 }, nitpick: { color: "var(--mr-ink-3)", bars: 1 },
};
const sev = (s: string) => SEV[s.toLowerCase()] ?? SEV.suggestion;
const NOVELTY: Record<string, { bg: string; color: string }> = {
  "net-new": { bg: "var(--mr-well)", color: "var(--mr-ink-2)" }, adjacent: { bg: "var(--mr-well)", color: "var(--mr-ink-2)" },
  overlapping: { bg: "var(--mr-needs)", color: "var(--mr-ink)" }, duplicate: { bg: "var(--mr-error)", color: "var(--mr-tile)" },
};

function SevMark({ s }: { s: string }) {
  const v = sev(s);
  return (
    <span className="mr-row" style={{ gap: 6, minWidth: 110 }}>
      <span style={{ display: "inline-flex", gap: 2 }} aria-hidden="true">{[1, 2, 3, 4].map((i) => <i key={i} style={{ width: 9, height: 6, background: i <= v.bars ? v.color : "var(--mr-well)" }} />)}</span>
      <strong style={{ color: v.color }}>{s}</strong>
    </span>
  );
}

function Diff({ code }: { code: string }) {
  return (
    <div className="mr-mono" style={{ fontSize: 12, background: "var(--mr-well)", overflowX: "auto" }}>
      {code.split("\n").map((l, i) => (
        <div key={i} style={{ padding: "1px 12px", whiteSpace: "pre", background: l.startsWith("+") ? "rgba(30,122,76,.14)" : l.startsWith("-") ? "rgba(198,40,40,.12)" : "transparent" }}>{l || " "}</div>
      ))}
    </div>
  );
}

export function ReviewView({ s }: { s: SessionState }) {
  const r = s.review!;
  const o = r.overview;
  const snip = r.current !== null ? r.snippets[r.current] : null;
  const total = o?.total_snippets ?? snip?.total ?? 0;
  const findings = Object.values(r.snippets).flatMap((x) => x.findings ?? []);
  const noted = findings.filter((f) => r.noted.includes(f.id));
  const reply = (text: string) => void api.send(s.id, text);
  const note = (id: string) => { void api.log("ui.review_noted", { finding_id: id }, s.id, `review:${id}`); reply(`note ${id}`); };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (keyOf(e) === "Enter" && e.metaKey && r.publish && !r.published) { e.preventDefault(); reply("publish"); return; }
      if (e.target instanceof HTMLInputElement || e.metaKey) return;
      if (keyOf(e) === " " && snip) { e.preventDefault(); reply("next"); }
      if (/^[1-9]$/.test(keyOf(e)) && snip?.findings?.[Number(keyOf(e)) - 1]) { e.preventDefault(); note(snip.findings[Number(keyOf(e)) - 1].id); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {o && (
        <section style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          <div style={{ flex: "2 1 420px", display: "flex", flexDirection: "column", gap: 10, padding: "14px 16px", background: "var(--mr-tile)" }}>
            <div className="mr-row" style={{ alignItems: "baseline" }}>
              {o.tier && <span style={{ padding: "2px 8px", background: o.tier === 1 ? "var(--mr-ink)" : "transparent", border: o.tier === 1 ? 0 : "1px solid var(--mr-ink)", color: o.tier === 1 ? "var(--mr-tile)" : "var(--mr-ink)", fontWeight: 700 }}>Tier {o.tier}</span>}
              <strong style={{ fontSize: 15 }}>{o.tier_label}</strong>
            </div>
            {o.summary && <span className="mr-ink2">{o.summary}</span>}
            {o.nodes && o.nodes.length > 0 && (
              <div className="mr-row" style={{ flexWrap: "wrap", gap: 6 }}>
                {o.nodes.map((n, i) => (
                  <span key={i} className="mr-row" style={{ gap: 6 }}>
                    <span style={{ padding: "6px 10px", background: "var(--mr-well)", fontSize: 12 }}>
                      <b className="mr-mono" style={{ color: n.mark === "+" ? "var(--mr-done)" : n.mark === "-" ? "var(--mr-error)" : "var(--mr-ink-2)" }}>{n.mark ?? "~"}</b> {n.label}
                      {n.finding && <i style={{ display: "inline-block", width: 7, height: 7, marginLeft: 6, background: n.finding === "critical" ? "var(--mr-error)" : "var(--mr-needs)" }} />}
                    </span>
                    {i < (o.nodes?.length ?? 0) - 1 && <span className="mr-dim">→</span>}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div style={{ flex: "1 1 300px", display: "flex", flexDirection: "column", gap: 6, padding: "14px 16px", background: "var(--mr-tile)" }}>
            <strong>Novelty</strong>
            {(o.novelty ?? []).map((n, i) => (
              <div key={i} className="mr-row" style={{ alignItems: "baseline" }}>
                <span style={{ minWidth: 90, padding: "1px 6px", textAlign: "center", fontSize: 11, fontWeight: 700, ...(NOVELTY[n.label.toLowerCase()] ?? NOVELTY["net-new"]) }}>{n.label}</span>
                <span className="mr-grow">{n.what}{n.where ? <span className="mr-mono mr-dim"> · {n.where}</span> : null}</span>
              </div>
            ))}
            {o.prior_threads !== undefined && <span className="mr-dim">{o.prior_threads} earlier threads checked</span>}
          </div>
        </section>
      )}

      {snip && (
        <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <ProgressTrack segs={Array.from({ length: Math.max(total, snip.n) }, (_, i) => (i + 1 < snip.n ? "done" : i + 1 === snip.n ? "current" : "todo"))} left={`Snippet ${snip.n} of ${total || "?"}${snip.area ? ` · ${snip.area}` : ""}`} right={`${noted.length} noted`} source={s.id} />
          <article style={{ display: "flex", flexDirection: "column", gap: 12, padding: "16px 18px", background: "var(--mr-tile)" }}>
            <strong style={{ fontSize: 18 }}>{snip.title}</strong>
            {snip.explain && <span className="mr-ink2">{snip.explain}</span>}
            {snip.file && <span className="mr-mono mr-dim" style={{ fontSize: 12 }}>{snip.file}</span>}
            {snip.code && <Diff code={snip.code} />}
            {snip.good && <span><b style={{ color: "var(--mr-done)" }}>Good </b><span className="mr-ink2">{snip.good}</span></span>}
            {(snip.findings ?? []).map((f, i) => {
              const on = r.noted.includes(f.id);
              return (
                <div key={f.id} className="mr-row" style={{ alignItems: "flex-start", padding: "10px 12px", background: "var(--mr-well)" }}>
                  <SevMark s={f.severity} />
                  <span className="mr-grow">{f.text}{f.at && <span className="mr-mono mr-dim"> · {f.at}</span>}</span>
                  <Key k={String(i + 1)} tone={on ? "primary" : undefined} onClick={() => !on && note(f.id)}>{on ? "Noted ✓" : "Note it"}</Key>
                </div>
              );
            })}
          </article>
          <div className="mr-row"><Key k="space" tone="primary" onClick={() => reply("next")}>Next snippet</Key><span className="mr-dim">Only findings you note get published · ask anything below</span></div>
        </section>
      )}

      {(r.publish || noted.length > 0) && (
        <section style={{ display: "flex", flexDirection: "column", gap: 8, padding: "14px 16px", background: "var(--mr-tile)" }}>
          <strong>{r.published ? "✓ Published · " : "Your review "}{r.publish?.verdict ?? ""}</strong>
          {(r.publish?.comments ?? noted).map((c, i) => (
            <div key={i} className="mr-row" style={{ alignItems: "flex-start" }}><SevMark s={c.severity} /><span className="mr-grow">{c.text}{c.at && <span className="mr-mono mr-dim"> · {c.at}</span>}</span></div>
          ))}
          {r.publish?.dropped ? <span className="mr-dim">{r.publish.dropped} dropped as duplicates of earlier threads</span> : null}
          {r.publish && !r.published && <Key k="⌘↵" tone="primary" onClick={() => reply("publish")}>Publish as one review</Key>}
          {r.published && <span className="mr-dim">Posted to the PR as one review. Mark this session done (⌘⇧D) to clear it from the wall.</span>}
        </section>
      )}
      {!o && !snip && <span className="mr-dim">The review is starting. The overview appears here when it's ready.</span>}
    </div>
  );
}

export function AddressView({ s }: { s: SessionState }) {
  const a = s.address!;
  // A thread's state is what happened to it in this session (J8): a reply means fixed now, a
  // pushed-back option means deferred; otherwise whatever the PR said at the start.
  const stateOf = (t: { id: string; state?: string }) => {
    if (t.state === "already" || t.state === "resolved") return "already";
    const opt = a.threads[t.id]?.options?.find((o) => o.id === a.chosen[t.id]);
    if (opt && /push back|defer|later/i.test(opt.label)) return "deferred";
    if (a.replies[t.id] || opt) return "fixed";
    return t.state ?? "open";
  };
  const threads = (a.list?.threads ?? []).map((t) => ({ ...t, state: stateOf(t) }));
  const [viewing, setViewing] = useState<string | null>(null);
  const shownId = viewing ?? a.current;
  const cur = shownId ? a.threads[shownId] : null;
  const tally = (st: string) => threads.filter((t) => t.state === st).length;
  const choose = (id: string, opt: { id: string; label: string }) => {
    void api.log("ui.address_chosen", { id, option: opt.id }, s.id, `address:${id}`);
    void api.send(s.id, `Option ${opt.id}: ${opt.label}`);
  };
  const proof = shownId ? a.proofs[shownId] : undefined;
  const replyMsg = shownId ? a.replies[shownId] : undefined;
  const canChoose = !!cur && cur.id === a.current && !a.chosen[cur.id];
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.metaKey || !canChoose || !cur) return;
      const o = (cur.options ?? []).find((x) => x.id === keyOf(e));
      if (o) { e.preventDefault(); choose(cur.id, o); }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });
  const parts: [string, string][] = [["already", "var(--mr-done)"], ["fixed", "var(--mr-ink)"], ["deferred", "var(--mr-ink-3)"], ["open", "var(--mr-well)"]];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {threads.length > 0 && (
        <section style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", height: 10, gap: 2 }}>{parts.map(([k, c]) => tally(k) > 0 && <span key={k} style={{ flex: tally(k), background: c }} />)}</div>
          <div className="mr-row mr-ink2" style={{ flexWrap: "wrap" }}>
            <span><b style={{ color: "var(--mr-done)" }}>{tally("already")}</b> already fixed</span><span><b>{tally("fixed")}</b> fixed now</span><span><b>{tally("deferred")}</b> deferred</span><span className="mr-dim">{tally("open")} to go</span>
            <span className="mr-grow" /><span className="mr-dim">{a.list?.round}{a.list?.moved_commits ? ` · branch moved ${a.list.moved_commits} commits` : ""}</span>
          </div>
        </section>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        <nav style={{ flex: "1 1 240px", maxWidth: 320, display: "flex", flexDirection: "column", gap: "var(--mr-gap)" }}>
          {threads.map((t) => (
            <button key={t.id} type="button" onClick={() => setViewing(t.id === a.current ? null : t.id)} disabled={!a.threads[t.id]} title={a.threads[t.id] ? "Show this thread" : "Not reached yet"} className="mr-row" style={{ alignItems: "flex-start", padding: "8px 10px", border: 0, font: "inherit", color: "inherit", textAlign: "left", cursor: a.threads[t.id] ? "pointer" : "default", background: t.id === shownId ? "var(--mr-tile)" : "var(--mr-well)", outline: t.id === shownId ? "2px solid var(--mr-selected)" : undefined, outlineOffset: -2 }}>
              <span aria-hidden="true" style={{ width: 14, color: t.state === "open" ? "var(--mr-needs-ink)" : t.state === "deferred" ? "var(--mr-ink-3)" : "var(--mr-done)" }}>{t.state === "open" ? "◆" : t.state === "deferred" ? "–" : "✓"}</span>
              <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}><span className="mr-mono mr-dim" style={{ fontSize: 11 }}>{t.at}{t.id === a.current ? " · now" : ""}</span><span className="mr-ellipsis">{t.short}</span></span>
            </button>
          ))}
        </nav>
        <section style={{ flex: "999 1 480px", minWidth: 0, display: "flex", flexDirection: "column", gap: 10 }}>
          {cur ? (
            <>
              <article style={{ display: "flex", flexDirection: "column", gap: 6, padding: "14px 16px", background: "var(--mr-tile)" }}>
                <div className="mr-row"><b>{cur.reviewer ? `@${cur.reviewer}` : "Reviewer"}</b><span className="mr-mono mr-dim">{cur.at}</span><span className="mr-grow" /><b style={{ color: stateOf(cur) === "open" ? "var(--mr-needs-ink)" : "var(--mr-done)" }}>{stateOf(cur) === "already" ? "✓ Already addressed" : stateOf(cur) === "fixed" ? "✓ Fixed in this session" : stateOf(cur) === "deferred" ? "– Pushed back" : "◆ Not addressed yet"}</b></div>
                <span style={{ fontSize: 15 }}>{cur.body}</span>
              </article>
              {cur.evidence_code && <div style={{ display: "flex", flexDirection: "column", gap: 4 }}><span className="mr-mono mr-dim" style={{ fontSize: 12 }}>{cur.evidence_file}</span><Diff code={cur.evidence_code} /></div>}
              {(cur.options ?? []).length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: "var(--mr-gap)" }}>
                  {(cur.options ?? []).map((o) => {
                    const picked = a.chosen[cur.id] === o.id;
                    return (
                      <button key={o.id} type="button" disabled={!canChoose && !picked} onClick={() => canChoose && choose(cur.id, o)} className="mr-row" style={{ alignItems: "baseline", padding: "10px 12px", border: 0, background: picked ? "var(--mr-ink)" : "var(--mr-tile)", color: picked ? "var(--mr-tile)" : "var(--mr-ink)", font: "inherit", textAlign: "left", cursor: "pointer" }}>
                        <kbd className="mr-mono" style={{ padding: "0 6px", background: picked ? "transparent" : "var(--mr-well)" }}>{o.id}</kbd>
                        <span className="mr-grow"><b>{o.label}</b>{o.recommended && <span style={{ opacity: 0.7 }}> · recommended</span>}<br /><span style={{ opacity: 0.8 }}>{o.detail}</span></span>
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          ) : <span className="mr-dim">{threads.length ? "Waiting for the next thread…" : "Fetching the review threads…"}</span>}
        </section>
        {(proof || replyMsg) && (
          <aside style={{ flex: "1 1 260px", maxWidth: 360, display: "flex", flexDirection: "column", gap: 10 }}>
            {proof && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "12px 14px", background: "var(--mr-tile)" }}>
                <strong>Proof before reply</strong>
                {proof.map((c, i) => <div key={i} className="mr-row"><span style={{ color: c.ok ? "var(--mr-done)" : c.ok === false ? "var(--mr-error)" : "var(--mr-ink-3)" }}>{c.ok ? "✓" : c.ok === false ? "✕" : "○"}</span><span className="mr-grow">{c.label}</span><span className="mr-mono mr-dim" style={{ fontSize: 11 }}>{c.proof}</span></div>)}
              </div>
            )}
            {replyMsg && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "12px 14px", background: "var(--mr-tile)" }}>
                <strong>{replyMsg.posted ? "Replied ✓" : "Reply"}</strong>
                <span style={{ padding: "8px 10px", background: "var(--mr-well)" }}>{replyMsg.text}</span>
                {replyMsg.sha && <span className="mr-mono mr-dim">{replyMsg.sha}</span>}
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
