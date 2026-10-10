import { isOpenQuestion, type Doc } from "../state/docs";
import type { Pr } from "../state/store";
import type { AppState } from "../state/types";
import { pickTile } from "./pick";
import { plural, sessionTitle } from "./title";
import { fixReady } from "./queue";

// The suggested-next engine (decision 20): plain rules that propose the next useful move, each with
// its reason, as a one-click action. At most three; dismissed ones stay hidden.

export type Suggestion = {
  id: string; // stable, so a dismissal sticks
  why: string;
  what: string;
  action: { kind: "open_session"; id: string } | { kind: "open_doc"; id: string } | { kind: "resume"; id: string } | { kind: "start"; mode: "review" | "address"; value: string } | { kind: "build_mine" };
  label: string;
  rank: number; // lower first
};

export function suggest(state: AppState, docs: Doc[], prs: { review: Pr[]; mine: Pr[] }, dismissed: Set<string>): Suggestion[] {
  const out: Suggestion[] = [];
  const sessions = state.order.map((id) => state.sessions[id]);

  for (const d of docs) {
    const open = Object.values(d.blocks).filter(isOpenQuestion);
    // Open questions and prose asks live in the needs-you queue, never here too (F2).
    if (!open.length && d.pending_notes.length + d.pending_changes.length) out.push({ id: `doc-regen:${d.id}:${d.version}`, why: `Your notes on “${d.title}” aren't sent yet`, what: "Regenerate the doc with them", action: { kind: "open_doc", id: d.id }, label: "Open", rank: 2 });
  }
  for (const s of sessions) {
    const t = pickTile(s);
    if (t.state === "interrupted" && s.sdkSessionId) out.push({ id: `resume:${s.id}`, why: "Stopped when the app closed", what: `Resume “${sessionTitle(s)}”`, action: { kind: "resume", id: s.id }, label: "Resume", rank: 3 });
    if ((t.state === "idle" || t.state === "done") && Object.keys(s.files).length && !fixReady(s)) out.push({ id: `diff:${s.id}:${Object.keys(s.files).length}`, why: `${plural(Object.keys(s.files).length, "file")} changed in “${sessionTitle(s)}”`, what: "Review its changes", action: { kind: "open_session", id: s.id }, label: "Review", rank: 4 });
  }
  // Applied fixes only reach the app you're using after a rebuild (J14).
  const applied = sessions.filter((s) => s.fixApplied && s.fixApplied > (state.lastBuildAt ?? 0)).length;
  if (applied) out.push({ id: `rebuild:${applied}`, why: `${plural(applied, "fix")} applied to your app`, what: "Rebuild and relaunch to use it", action: { kind: "build_mine" }, label: "Rebuild & relaunch", rank: 1 });
  const reviewing = new Set(sessions.filter((s) => s.kind === "review").map((s) => s.title));
  for (const p of prs.review) if (![...reviewing].some((t) => t.includes(String(p.number)))) out.push({ id: `pr-review:${p.number}`, why: `PR #${p.number} waits for your review${p.author ? ` (@${p.author.login})` : ""}`, what: p.title, action: { kind: "start", mode: "review", value: p.url }, label: "Start review", rank: 5 });
  for (const p of prs.mine) if (p.reviewDecision === "CHANGES_REQUESTED") out.push({ id: `pr-address:${p.number}`, why: `Changes requested on your PR #${p.number}`, what: p.title, action: { kind: "start", mode: "address", value: String(p.number) }, label: "Address", rank: 2 });

  return out.filter((x) => !dismissed.has(x.id)).sort((a, b) => a.rank - b.rank).slice(0, 3);
}
