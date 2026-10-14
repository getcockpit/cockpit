import { useEffect, useState } from "react";
import { ChangeList, NoveltyTag, TierBadge } from "../components/CatalogView";
import { ChangeDiagram } from "../components/ChangeDiagram";
import { Key } from "../components";
import { keyOf } from "../components/keys";
import { modKey } from "../platform";
import { plural } from "../picker/title";
import type { ReviewFlow } from "../state/types";

// The review overview as a pyramid (MR-58): the answer first (one verdict line with counts), then
// a few one-line key points you can open, act on or skip, then the supporting detail, folded.
// Start the walkthrough with a button instead of typing "ok".

type Overview = NonNullable<ReviewFlow["overview"]>;
export type Point = { tag: "Blocker" | "New" | "Context" | "Question"; line: string; full: string };

const firstSentence = (t: string) => {
  const m = t.match(/^(.{20,160}?[.?!])(\s|$)/);
  return (m ? m[1] : t.slice(0, 140)).trim();
};

/** The overview's questions/notes as key points, most important first. */
export function keyPoints(o: Overview): Point[] {
  const pts = (o.questions ?? []).map((q): Point => {
    const t = q.trim();
    const tag: Point["tag"] = /^blocker/i.test(t) ? "Blocker" : /^new\b/i.test(t) ? "New" : /delta-only|skipped|already raised|context/i.test(t) ? "Context" : "Question";
    const body = t.replace(/^(blocker[^:]*|new)\s*:\s*/i, "");
    return { tag, line: firstSentence(body), full: body };
  });
  const rank = { Blocker: 0, New: 1, Question: 2, Context: 3 };
  return pts.sort((a, b) => rank[a.tag] - rank[b.tag]);
}

/** One line that answers "how worried should I be?". */
export function verdict(o: Overview, pts: Point[]): string {
  const blockers = pts.filter((p) => p.tag === "Blocker").length;
  // Count what the key points below show, so the verdict and the list agree.
  const fresh = pts.filter((p) => p.tag === "New").length;
  const parts = [blockers ? plural(blockers, "blocker") : "", fresh ? plural(fresh, "new finding") : "", o.total_snippets ? `${plural(o.total_snippets, "snippet")} to walk` : ""].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Nothing new to raise";
}

const TAG: Record<Point["tag"], { bg: string; fg: string }> = {
  Blocker: { bg: "var(--mr-error)", fg: "var(--mr-tile)" },
  New: { bg: "var(--mr-needs)", fg: "var(--mr-ink)" },
  Question: { bg: "var(--mr-well)", fg: "var(--mr-ink)" },
  Context: { bg: "transparent", fg: "var(--mr-ink-3)" },
};

export function ReviewOverview({ o, started, onReply, onRaise, raised }: { o: Overview; started: boolean; onReply: (t: string) => void; onRaise: (id: string, text: string) => void; raised: string[] }) {
  const pts = keyPoints(o);
  const graph = (o.edges ?? []).length > 0;
  const [sel, setSel] = useState(0);
  const [open, setOpen] = useState<number | null>(null);
  const [skipped, setSkipped] = useState<number[]>([]);
  const [ask, setAsk] = useState("");
  const summary = (o.summary ?? "").split(/(?<=[.!?])\s+(?=[A-Z"/])/).filter(Boolean);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.("input, textarea") || modKey(e)) return;
      const key = keyOf(e);
      if (key === "j") { e.preventDefault(); setSel((x) => Math.min(pts.length - 1, x + 1)); }
      if (key === "k") { e.preventDefault(); setSel((x) => Math.max(0, x - 1)); }
      if (key === "Enter") { e.preventDefault(); setOpen((x) => (x === sel ? null : sel)); }
      if (key === "n" && pts[sel]) { e.preventDefault(); onRaise(`ov:${sel}`, pts[sel].full); }
      if (key === " " && !started) { e.preventDefault(); onReply("ok"); }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });

  return (
    <section data-mr="ReviewOverview" data-mr-source={o.pr} style={{ display: "flex", flexDirection: "column", gap: "var(--mr-gap)" }}>
      {/* 1. The answer */}
      <div style={{ padding: "14px 16px", background: "var(--mr-tile)", display: "flex", flexDirection: "column", gap: 6 }}>
        <div className="mr-row" style={{ gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
          {o.tier && <TierBadge tier={o.tier} title={o.tier_label} />}
          <strong style={{ fontSize: 20, lineHeight: 1.2 }}>{verdict(o, pts)}</strong>
        </div>
        {o.tier_label && <span className="mr-ink2">{firstSentence(o.tier_label)}</span>}
        {!started && (
          <div className="mr-row" style={{ gap: 10, marginTop: 6, flexWrap: "wrap" }}>
            <Key k="space" tone="primary" onClick={() => onReply("ok")}>Start walkthrough{o.total_snippets ? ` · ${plural(o.total_snippets, "snippet")}` : ""}</Key>
            <span className="mr-dim">J/K move · ↵ open · N raise it in the review</span>
          </div>
        )}
      </div>

      {/* 2. Key points: one line each; open one to act on it */}
      {pts.map((p, i) => {
        const isOpen = open === i, isRaised = raised.includes(`ov:${i}`), isSkipped = skipped.includes(i);
        return (
          <div key={i} data-mr="ReviewPoint" data-mr-source={`${o.pr}:${i}`} aria-current={i === sel || undefined} style={{ background: "var(--mr-tile)", opacity: isSkipped ? 0.5 : 1, transition: "opacity var(--mr-med), box-shadow var(--mr-med)", boxShadow: i === sel ? "inset 3px 0 0 var(--mr-selected)" : undefined }}>
            <button type="button" onClick={() => { setSel(i); setOpen(isOpen ? null : i); }} className="mr-row"
              style={{ width: "100%", gap: 10, padding: "10px 14px", border: 0, background: "transparent", font: "inherit", color: "var(--mr-ink)", textAlign: "left", cursor: "pointer" }}>
              <span style={{ flex: "none", minWidth: 64, padding: "1px 6px", fontSize: 11, fontWeight: 700, textAlign: "center", background: TAG[p.tag].bg, color: TAG[p.tag].fg, boxShadow: p.tag === "Context" ? "inset 0 0 0 1px var(--mr-ink-3)" : undefined }}>{p.tag}</span>
              <span className="mr-grow" style={{ fontWeight: p.tag === "Context" ? 400 : 600 }}>{p.line}</span>
              {isRaised && <span style={{ color: "var(--mr-done)", fontSize: 12 }}>✓ in your review</span>}
              <span className="mr-dim mr-chev" data-open={isOpen} aria-hidden>▸</span>
            </button>
            {isOpen && (
              <div className="mr-reveal" style={{ padding: "0 14px 12px 88px", display: "flex", flexDirection: "column", gap: 8 }}>
                {/* Only what the headline doesn't already say. */}
                {p.full.slice(p.line.length).trim() && <span className="mr-ink2">{p.full.slice(p.line.length).trim()}</span>}
                <div className="mr-row" style={{ gap: 8, flexWrap: "wrap" }}>
                  <Key k="N" tone={isRaised ? undefined : "primary"} onClick={() => onRaise(`ov:${i}`, p.full)}>{isRaised ? "Raised ✓ · undo" : "Raise it in the review"}</Key>
                  <button type="button" className="mr-link" onClick={() => { setSkipped((x) => (isSkipped ? x.filter((y) => y !== i) : [...x, i])); setOpen(null); }}>{isSkipped ? "Unskip" : "Skip"}</button>
                </div>
                <form className="mr-row" onSubmit={(e) => { e.preventDefault(); if (ask.trim()) { onReply(`About "${p.line}": ${ask.trim()}`); setAsk(""); } }}>
                  <input className="mr-input" value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="Ask Claude about this point" aria-label="Ask about this point" style={{ background: "var(--mr-well)" }} />
                </form>
              </div>
            )}
          </div>
        );
      })}

      {/* 3. Supporting detail, folded */}
      <details style={{ background: "var(--mr-tile)", padding: "10px 14px" }}>
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>What the PR changes <span className="mr-dim" style={{ fontWeight: 400 }}>{(o.nodes ?? []).length ? `· ${plural((o.nodes ?? []).length, "change")}` : ""}</span></summary>
        <ul style={{ margin: "8px 0 0", paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>{summary.map((x, i) => <li key={i} className="mr-ink2">{x}</li>)}</ul>
        {(o.nodes ?? []).length > 0 && <div style={{ marginTop: 12 }}>{graph ? <ChangeDiagram nodes={o.nodes ?? []} edges={o.edges ?? []} /> : <ChangeList nodes={o.nodes ?? []} grouped />}</div>}
      </details>
      {(o.novelty ?? []).length > 0 && (
        <details style={{ background: "var(--mr-tile)", padding: "10px 14px" }}>
          <summary style={{ cursor: "pointer", fontWeight: 600 }}>New vs. already in the codebase <span className="mr-dim" style={{ fontWeight: 400 }}>· {o.prior_threads ?? 0} earlier threads checked</span></summary>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
            {(o.novelty ?? []).map((n, i) => <div key={i} style={{ display: "flex", alignItems: "baseline", gap: 10 }}><NoveltyTag verdict={n.label} /><span className="mr-grow">{n.what}</span>{n.where && <span className="mr-mono mr-dim" style={{ fontSize: 11 }}>{n.where}</span>}</div>)}
          </div>
        </details>
      )}
    </section>
  );
}
