import { isOpenQuestion, type Doc } from "../state/docs";
import type { Pr } from "../state/store";
import type { AppState } from "../state/types";
import { pickTile } from "./pick";

// The suggested-next engine (decision 20): plain rules that propose the next useful move, each with
// its reason, as a one-click action. At most three; dismissed ones stay hidden.

export type Suggestion = {
  id: string; // stable, so a dismissal sticks
  why: string;
  what: string;
  action: { kind: "open_session"; id: string } | { kind: "open_doc"; id: string } | { kind: "resume"; id: string } | { kind: "start"; mode: "review" | "address"; value: string };
  label: string;
  rank: number; // lower first
};

export function suggest(state: AppState, docs: Doc[], prs: { review: Pr[]; mine: Pr[] }, dismissed: Set<string>): Suggestion[] {
  const out: Suggestion[] = [];
  const sessions = state.order.map((id) => state.sessions[id]);

  for (const d of docs) {
    const open = Object.values(d.blocks).filter(isOpenQuestion);
    if (open.length) out.push({ id: `doc-q:${d.id}:${open.length}`, why: `${open.length} open question${open.length === 1 ? "" : "s"} in “${d.title}”`, what: open[0].takeaway, action: { kind: "open_doc", id: d.id }, label: "Decide", rank: 1 });
    else if (d.pending_notes.length + d.pending_changes.length) out.push({ id: `doc-regen:${d.id}:${d.version}`, why: `Your notes on “${d.title}” aren't sent yet`, what: "Regenerate the doc with them", action: { kind: "open_doc", id: d.id }, label: "Open", rank: 2 });
  }
  for (const s of sessions) {
    const t = pickTile(s);
    if (t.state === "needs_you" && !s.pending.length) out.push({ id: `asked:${s.id}:${s.transcript.length}`, why: `“${s.title.slice(0, 40)}” asked you something`, what: t.doing.replace(/^Asks: /, ""), action: { kind: "open_session", id: s.id }, label: "Answer", rank: 1 });
    if (t.state === "interrupted" && s.sdkSessionId) out.push({ id: `resume:${s.id}`, why: "Stopped when the app closed", what: `Resume “${s.title.slice(0, 50)}”`, action: { kind: "resume", id: s.id }, label: "Resume", rank: 3 });
    if ((t.state === "idle" || t.state === "done") && Object.keys(s.files).length) out.push({ id: `diff:${s.id}:${Object.keys(s.files).length}`, why: `${Object.keys(s.files).length} files changed in “${s.title.slice(0, 40)}”`, what: "Review its changes", action: { kind: "open_session", id: s.id }, label: "Review", rank: 4 });
  }
  const reviewing = new Set(sessions.filter((s) => s.kind === "review").map((s) => s.title));
  for (const p of prs.review) if (![...reviewing].some((t) => t.includes(String(p.number)))) out.push({ id: `pr-review:${p.number}`, why: `PR #${p.number} waits for your review${p.author ? ` (@${p.author.login})` : ""}`, what: p.title, action: { kind: "start", mode: "review", value: p.url }, label: "Start review", rank: 5 });
  for (const p of prs.mine) if (p.reviewDecision === "CHANGES_REQUESTED") out.push({ id: `pr-address:${p.number}`, why: `Changes requested on your PR #${p.number}`, what: p.title, action: { kind: "start", mode: "address", value: String(p.number) }, label: "Address", rank: 2 });

  return out.filter((x) => !dismissed.has(x.id)).sort((a, b) => a.rank - b.rank).slice(0, 3);
}
