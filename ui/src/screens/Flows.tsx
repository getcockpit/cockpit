import { keyOf } from "../components/keys";
import { useEffect, useState } from "react";
import { Key, ProgressTrack } from "../components";
import { Diff } from "../components/Diff";
import { CatalogView, Checklist, FixOptions, SevBars, Tally, Thread } from "../components/CatalogView";
import { DeliveryMark } from "../components";
import { TurnText } from "../components/Turn";
import { api } from "../state/store";
import { ReviewOverview } from "./ReviewOverview";
import { plural } from "../picker/title";
import type { SessionState, TranscriptItem } from "../state/types";

// Review (mirrors /review) and Address (mirrors pr-address), drawn from the flow.* steps Claude
// reports. User actions go back as the replies those commands already expect.

export function ReviewView({ s }: { s: SessionState }) {
  const r = s.review!;
  const o = r.overview;
  // Any snippet can be opened at any point (MR-113): reached ones show from the log, unreached ones
  // ask Claude to jump there. `viewing` is a local look-back; Claude stays on r.current.
  const [viewing, setViewing] = useState<number | null>(null);
  useEffect(() => setViewing(null), [r.current]);
  const shownN = viewing ?? r.current;
  const snip = shownN !== null ? r.snippets[shownN] ?? null : null;
  const live = !!snip && snip.n === r.current;
  // The overview's count is an estimate: never show "Snippet 3 of 2".
  const total = Math.max(o?.total_snippets ?? snip?.total ?? 0, ...Object.keys(r.snippets).map(Number), 0);
  const findings = Object.values(r.snippets).flatMap((x) => x.findings ?? []);
  const noted = findings.filter((f) => r.noted.includes(f.id));
  const reply = (text: string) => void api.send(s.id, text);
  const note = (id: string) => { void api.log("ui.review_noted", { finding_id: id }, s.id, `review:${id}`); reply(`note ${id}`); };
  const go = (n: number) => {
    if (n < 1 || n > total) return;
    if (n === r.current) setViewing(null);
    else if (r.snippets[n]) setViewing(n);
    else reply(`snippet ${n}`);
  };
  const back = () => setViewing(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (keyOf(e) === "Enter" && e.metaKey && r.publish && !r.published) { e.preventDefault(); reply("publish"); return; }
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.metaKey) return;
      if (keyOf(e) === " " && snip) { e.preventDefault(); if (live) reply("next"); else back(); }
      if (keyOf(e) === "ArrowLeft" && shownN !== null) { e.preventDefault(); go(shownN - 1); }
      if (keyOf(e) === "ArrowRight" && shownN !== null) { e.preventDefault(); go(shownN + 1); }
      if (/^[1-9]$/.test(keyOf(e)) && snip?.findings?.[Number(keyOf(e)) - 1]) { e.preventDefault(); note(snip.findings[Number(keyOf(e)) - 1].id); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {o && <ReviewOverview o={o} started={r.current !== null || !!r.publish} onReply={reply} raised={r.noted}
        onRaise={(id, text) => { if (r.noted.includes(id)) return; void api.log("ui.review_noted", { finding_id: id }, s.id, `review:${id}`); reply(`Add this to the review as a comment: ${text}`); }} />}

      {total > 0 && Object.keys(r.snippets).length > 0 && (
        <SnippetPager total={total} reached={Object.keys(r.snippets).map(Number)} shown={snip?.n ?? null} current={r.current} source={s.id} onGo={go} />
      )}

      {snip && (
        <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <ProgressTrack segs={Array.from({ length: total }, (_, i) => (i + 1 === snip.n ? "current" : r.snippets[i + 1] ? "done" : "todo"))} left={`Snippet ${snip.n} of ${total || "?"}${snip.area ? ` · ${snip.area}` : ""}${live ? "" : " · looking back"}`} right={`${noted.length} noted`} source={s.id} />
          <article style={{ display: "flex", flexDirection: "column", gap: 12, padding: "16px 18px", background: "var(--mr-tile)" }}>
            <strong style={{ fontSize: 18 }}>{snip.title}</strong>
            {/* Answer first (MR-58): what's wrong, then why, then the code. */}
            <span className="mr-ink2">{(snip.findings ?? []).length ? `${plural((snip.findings ?? []).length, "finding")} here` : "Nothing to raise here"}{snip.good ? ` · good: ${snip.good}` : ""}</span>
            {(snip.findings ?? []).map((f, i) => {
              const on = r.noted.includes(f.id);
              return (
                <div key={f.id} className="mr-row" style={{ alignItems: "baseline", gap: 10, padding: "10px 12px", background: "var(--mr-well)" }}>
                  <SevBars severity={f.severity} />
                  <span className="mr-grow">{f.text}{f.at && <span className="mr-mono mr-dim"> · {f.at}</span>}</span>
                  <Key k={String(i + 1)} tone={on ? "primary" : undefined} onClick={() => !on && note(f.id)}>{on ? "Noted ✓" : "Note it"}</Key>
                </div>
              );
            })}
            {snip.explain && <span className="mr-ink2">{snip.explain}</span>}
            {snip.file && <span className="mr-mono mr-dim" style={{ fontSize: 12 }}>{snip.file}</span>}
            {snip.code && <Diff code={snip.code} />}
          </article>
          <div className="mr-row">
            {live
              ? <Key k="space" tone="primary" onClick={() => reply("next")}>{snip.n >= total ? "Finish walkthrough" : "Next snippet"}</Key>
              : <Key k="space" tone="primary" onClick={back}>{r.current !== null ? `Back to snippet ${r.current}` : "Back to your review"}</Key>}
            <span className="mr-dim">← → switch snippets · only findings you note get published · ask anything below</span>
          </div>
        </section>
      )}

      {(r.publish || noted.length > 0) && (
        <section style={{ display: "flex", flexDirection: "column", gap: 8, padding: "14px 16px", background: "var(--mr-tile)" }}>
          <strong>{r.published ? "✓ Published" : "Your review"}{r.publish?.verdict ? ` · ${r.publish.verdict}` : ""}</strong>
          {(r.publish?.comments ?? noted).map((c, i) => (
            <div key={i} className="mr-row" style={{ alignItems: "baseline", gap: 10 }}><SevBars severity={c.severity} /><span className="mr-grow">{c.text}{c.at && <span className="mr-mono mr-dim"> · {c.at}</span>}</span></div>
          ))}
          {r.publish?.dropped ? <span className="mr-dim">{r.publish.dropped} dropped as duplicates of earlier threads</span> : null}
          {r.publish && !r.published && <Key k="⌘↵" tone="primary" onClick={() => reply("publish")}>Publish as one review</Key>}
          {r.published && <span className="mr-dim">Posted to the PR as one review. Mark this session done (⌘⇧D) to clear it from the wall.</span>}
        </section>
      )}
      {!o && !snip && <span className="mr-dim">The review is starting. The overview appears here when it's ready.</span>}
      <FlowChat s={s} />
    </div>
  );
}

// Every snippet as a numbered stop: reached ones open from the log, unreached ones ask Claude to jump.
export function SnippetPager({ total, reached, shown, current, source, onGo }: { total: number; reached: number[]; shown: number | null; current: number | null; source: string; onGo: (n: number) => void }) {
  return (
    <nav className="mr-row" data-mr="SnippetPager" data-mr-source={source} aria-label="Snippets" style={{ gap: "var(--mr-gap)", flexWrap: "wrap" }}>
      {Array.from({ length: total }, (_, i) => i + 1).map((n) => {
        const seen = reached.includes(n);
        return (
          <button key={n} type="button" onClick={() => onGo(n)} aria-current={n === shown || undefined}
            title={n === current ? "Claude is here" : seen ? "Look back at this snippet" : "Ask Claude to jump here"}
            className="mr-mono" style={{ minWidth: 32, padding: "4px 8px", border: 0, font: "inherit", cursor: "pointer", color: seen ? "var(--mr-ink)" : "var(--mr-ink-3)", background: n === shown ? "var(--mr-tile)" : "var(--mr-well)", outline: n === shown ? "2px solid var(--mr-selected)" : undefined, outlineOffset: -2 }}>
            {n}{n === current ? " ·" : ""}
          </button>
        );
      })}
    </nav>
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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {threads.length > 0 && (
        <section style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <Tally b={{ type: "tally", items: [{ n: tally("already"), label: "already fixed", tone: "done" }, { n: tally("fixed"), label: "fixed now", tone: "now" }, { n: tally("deferred"), label: "deferred", tone: "deferred" }, { n: tally("open"), label: "to go", tone: "todo" }] }} />
          {(a.list?.round || a.list?.moved_commits) && <span className="mr-dim" style={{ alignSelf: "flex-end" }}>{a.list?.round}{a.list?.moved_commits ? ` · branch moved ${a.list.moved_commits} commits` : ""}</span>}
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
              <Thread b={{ type: "thread", author: cur.reviewer ?? "", where: cur.at, state: stateOf(cur), body: cur.body }} />
              {cur.evidence_code && <div style={{ display: "flex", flexDirection: "column", gap: 4 }}><span className="mr-mono mr-dim" style={{ fontSize: 12 }}>{cur.evidence_file}</span><Diff code={cur.evidence_code} /></div>}
              {(cur.options ?? []).length > 0 && (
                <FixOptions b={{ type: "fix_options", options: cur.options ?? [] }} live={canChoose} picked={a.chosen[cur.id]} onReply={() => {}}
                  onPick={(o) => { const opt = (cur.options ?? []).find((x) => x.id === o.id); if (opt) choose(cur.id, opt); }} />
              )}
            </>
          ) : <span className="mr-dim">{threads.length ? "Waiting for the next thread…" : "Fetching the review threads…"}</span>}
        </section>
        {(proof || replyMsg) && (
          <aside style={{ flex: "1 1 260px", maxWidth: 360, display: "flex", flexDirection: "column", gap: 10 }}>
            {proof && (
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <strong style={{ padding: "8px 16px 0", background: "var(--mr-tile)" }}>Proof before reply</strong>
                <Checklist b={{ type: "checklist", items: proof }} />
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
      <FlowChat s={s} />
    </div>
  );
}

// The flow's own button replies (next, note f1, Option 2: …) drive the visuals above; anything else
// you type is a question, so it and Claude's answer show here instead of vanishing.
const CONTROL = /^(ok|next|publish|note \S+|snippet \d+|Option [^:]+: .*|Add this to the review as a comment: [\s\S]*)$/i;

export type Exchange = { ask: Extract<TranscriptItem, { kind: "user" }>; answer: Extract<TranscriptItem, { kind: "text" | "view" }>[] };

export function flowChat(items: TranscriptItem[]): Exchange[] {
  const out: Exchange[] = [];
  let cur: Exchange | null = null;
  let first = true; // the session's opening prompt (/review <pr>) is the flow itself
  for (const t of items) {
    if (t.kind === "user") {
      cur = !first && !CONTROL.test(t.text.trim()) ? { ask: t, answer: [] } : null;
      if (cur) out.push(cur);
      first = false;
    } else if (cur && (t.kind === "text" || t.kind === "view")) cur.answer.push(t);
  }
  return out;
}

function FlowChat({ s }: { s: SessionState }) {
  const chat = flowChat(s.transcript);
  if (!chat.length) return null;
  const reply = (text: string) => void api.send(s.id, text);
  const last = chat.at(-1)!;
  return (
    <section data-mr="FlowChat" data-mr-source={s.id} style={{ display: "flex", flexDirection: "column", gap: "var(--mr-gap)" }}>
      <strong style={{ padding: "8px 0 2px" }}>Conversation</strong>
      {chat.map((x) => (
        <div key={x.ask.id} style={{ display: "flex", flexDirection: "column", gap: "var(--mr-gap)" }}>
          <div className="mr-row" style={{ padding: "10px 14px", background: "var(--mr-well)" }}><span className="mr-mono mr-dim">you →</span><span className="mr-grow">{x.ask.text}</span>{x.ask.delivery && <DeliveryMark d={x.ask.delivery} source={x.ask.id} />}</div>
          {x.answer.map((t) => t.kind === "text"
            ? <TurnText key={t.id} text={t.text} onReply={reply} live={false} />
            : <CatalogView key={t.id} id={t.id} title={t.title} blocks={t.blocks} onReply={reply} live={false} />)}
          {x === last && !x.answer.length && x.ask.delivery !== "answered" && x.ask.delivery !== "lost" && <span className="mr-dim" style={{ padding: "0 14px" }}>Claude is answering…</span>}
        </div>
      ))}
    </section>
  );
}
