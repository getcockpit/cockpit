import { useMemo, useState } from "react";
import { DecisionCard, Key, PickAny, WayOut, type Answer } from "../components";
import { decideQuestion, type Block, type Doc } from "../state/docs";
import { plural, sessionTitle } from "../picker/title";
import { shortError } from "../components/ErrorLine";
import { pickDecision } from "../picker/pick";
import { api } from "../state/store";
import type { PendingAsk, SessionState } from "../state/types";
import { basename } from "../fspath";

// Sends one answer for a pending ask (card click or keyboard).
export function answerAsk(s: SessionState, a: PendingAsk, x: Answer) {
  const decision =
    x.kind === "deny" ? { behavior: "deny", message: x.note ?? "The user denied this." }
    : x.kind === "answer" ? { behavior: "allow", updatedInput: { ...a.input, answers: x.answers } }
    : { behavior: "allow", updatedInput: a.input, ...(x.always && a.kind === "permission" && a.suggestions ? { updatedPermissions: a.suggestions } : {}) };
  return api.respond(s.id, a.requestId, decision);
}

// A needs-you row: where it's from (project / session as context, then the ask), plus the card.
export function AskRow({ s, a, selected, onOpen }: { s: SessionState; a: PendingAsk; selected?: boolean; onOpen?: () => void }) {
  const { spec } = useMemo(() => pickDecision(a), [a]);
  const answer = (x: Answer) => void answerAsk(s, a, x);
  return (
    <div className="mr-qrow" data-mr={spec.component} data-mr-source={`${s.id}:${a.requestId}`} data-mr-layer="code" aria-current={selected || undefined} style={selected ? { outline: "2px solid var(--mr-selected)", outlineOffset: -2 } : undefined} onDoubleClick={onOpen}>
      <div className="mr-flag" />
      <div className="mr-qbody">
        <span className="mr-row" style={{ gap: 6 }}>
          <strong className="mr-ink2">{where(s)}</strong>
          <span className="mr-dim">/</span>
          <span className="mr-ink2 mr-ellipsis">{sessionTitle(s)}</span>
        </span>
        <DecisionCard spec={spec} onAnswer={answer} />
      </div>
    </div>
  );
}

const where = (s: SessionState) => basename(s.repo ?? s.cwd) || s.cwd;

// A session that asked in prose (MR-41): the question on its own, quick replies it offers, and a
// reply box, so it's answered from the queue like any card.
export function ProseRow({ s, question, options, selected, onOpen }: { s: SessionState; question: string; options: string[]; selected?: boolean; onOpen: () => void }) {
  const [text, setText] = useState("");
  const send = (t: string) => { if (t.trim()) void api.send(s.id, t.trim()); };
  return (
    <div className="mr-qrow" data-mr="ProseAsk" data-mr-source={s.id} aria-current={selected || undefined} style={selected ? { outline: "2px solid var(--mr-selected)", outlineOffset: -2 } : undefined}>
      <div className="mr-flag" />
      <div className="mr-qbody">
        <span className="mr-row" style={{ gap: 6 }}>
          <strong className="mr-ink2">{where(s)}</strong><span className="mr-dim">/</span><span className="mr-ink2 mr-ellipsis">{sessionTitle(s)}</span>
          <span className="mr-grow" /><button type="button" className="mr-key" onClick={onOpen}>Open ↵</button>
        </span>
        <span className="mr-ask">{question}</span>
        <form className="mr-row" style={{ gap: 8, flexWrap: "wrap" }} onSubmit={(e) => { e.preventDefault(); send(text); setText(""); }}>
          {options.map((o, i) => <Key key={o} k={String(i + 1)} tone={i === 0 ? "primary" : undefined} onClick={() => send(o)}>{o}</Key>)}
          <input className="mr-input" data-reply={s.id} value={text} onChange={(e) => setText(e.target.value)} placeholder={options.length ? "…or reply in your own words" : "Reply…"} aria-label={`Reply to ${sessionTitle(s)}`} style={{ flex: "1 1 240px", background: "var(--mr-well)" }} />
        </form>
      </div>
    </div>
  );
}

// A doc question's way out (I75) is recorded as its decision, which Claude reads with the doc.
const DOC_SKIPPED = "Skipped: none of the options fit. Your call; say what you assumed.";
const DOC_ASK_FIRST = "None of the options fit. Ask me clarifying questions, then offer better options.";

// An open question in a working doc, decided right here. Deciding the last one sends the doc back
// to its plan session so it carries on.
export function DocQuestionRow({ d, b, session, selected, onOpen }: { d: Doc; b: Block; session?: SessionState | null; selected?: boolean; onOpen: () => void }) {
  const options = (b.data?.options ?? []) as { label: string; description: string }[];
  const decide = (label: string) => decideQuestion(d, b.id, label, session);
  return (
    <div className="mr-qrow" data-mr="DocQuestion" data-mr-source={`${d.id}:${b.id}`} aria-current={selected || undefined} style={selected ? { outline: "2px solid var(--mr-selected)", outlineOffset: -2 } : undefined}>
      <div className="mr-flag" />
      <div className="mr-qbody">
        <span className="mr-row" style={{ gap: 6 }}>
          <strong className="mr-ink2">Plan</strong><span className="mr-dim">/</span><span className="mr-ink2 mr-ellipsis">{d.title}</span>
          <span className="mr-grow" /><button type="button" className="mr-key" onClick={onOpen}>Open map ↵</button>
        </span>
        <span className="mr-ask">{b.takeaway}</span>
        {options.length > 0 && b.data?.multiSelect ? <PickAny source={`${d.id}:${b.id}`} options={options} decision={b.decision} onDecide={(l) => void decide(l)} /> : options.length > 0 ? (
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(options.length, 3)}, minmax(0, 1fr))`, gap: "var(--mr-gap)" }}>
            {options.map((o, i) => (
              <button key={o.label} type="button" data-option={i} onClick={() => void decide(o.label)} style={{ display: "flex", flexDirection: "column", gap: 4, padding: 12, border: 0, background: "var(--mr-well)", font: "inherit", color: "var(--mr-ink)", textAlign: "left", cursor: "pointer" }}>
                <span className="mr-row" style={{ gap: 8 }}><kbd className="mr-mono" style={{ padding: "0 6px", background: "var(--mr-tile)" }}>{i + 1}</kbd><strong>{o.label}</strong></span>
                <span className="mr-dim">{o.description}</span>
              </button>
            ))}
          </div>
        ) : <span className="mr-dim">{b.body}</span>}
        <WayOut source={`${d.id}:${b.id}`} onOut={(x) => void decide(x.kind === "reply" ? x.text : x.kind === "skip" ? DOC_SKIPPED : DOC_ASK_FIRST)} />
      </div>
    </div>
  );
}

// A Review/Address flow waiting on its next step (J8). The flow view is where you act, so this row
// says what's waiting and opens it.
export function FlowRow({ s, what, selected, onOpen }: { s: SessionState; what: string; selected?: boolean; onOpen: () => void }) {
  return (
    <div className="mr-qrow" data-mr="FlowWaiting" data-mr-source={s.id} aria-current={selected || undefined} style={selected ? { outline: "2px solid var(--mr-selected)", outlineOffset: -2 } : undefined}>
      <div className="mr-flag" />
      <div className="mr-qbody" style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
        <span style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 0 }}>
          <span className="mr-row" style={{ gap: 6 }}><strong className="mr-ink2">{s.kind === "review" ? "Review" : "Address"}</strong><span className="mr-dim">/</span><span className="mr-ink2 mr-ellipsis">{sessionTitle(s)}</span></span>
          <span className="mr-ask">{what}</span>
        </span>
        <Key k="↵" tone="primary" onClick={onOpen}>{s.kind === "review" ? "Continue review" : "Continue"}</Key>
      </div>
    </div>
  );
}

// Claude Code's login ran out (MR-153): sign in from the session (Claude's own /login), or send the
// refused message again if you already signed in elsewhere.
export function SignInRow({ s, selected, onOpen }: { s: SessionState; selected?: boolean; onOpen: () => void }) {
  return (
    <div className="mr-qrow" data-mr="SignInWaiting" data-mr-source={s.id} aria-current={selected || undefined} style={selected ? { outline: "2px solid var(--mr-selected)", outlineOffset: -2 } : undefined}>
      <div className="mr-flag" />
      <div className="mr-qbody" style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
        <span style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 0 }}>
          <span className="mr-row" style={{ gap: 6 }}><strong className="mr-ink2">Sign-in expired</strong><span className="mr-dim">/</span><span className="mr-ink2 mr-ellipsis">{sessionTitle(s)}</span></span>
          <span className="mr-ask">Claude Code's sign-in ran out. Sign in to send your message again.</span>
        </span>
        <button type="button" className="mr-key" onClick={() => void api.retrySignedIn(s.id, s.signedOut?.retry ?? "")}>Already signed in · send again</button>
        <Key k="↵" tone="primary" onClick={onOpen}>Sign in…</Key>
      </div>
    </div>
  );
}

// A god-mode fix that's ready (J14): apply it to your app right here, or look at it first.
export function FixRow({ s, selected, onOpen }: { s: SessionState; selected?: boolean; onOpen: () => void }) {
  const [state, setState] = useState<"" | "applying" | string>("");
  const apply = async () => { setState("applying"); try { await api.fixApply(s.id); setState(""); } catch (e) { setState(shortError(e)); } };
  return (
    <div className="mr-qrow" data-mr="FixReady" data-mr-source={s.id} aria-current={selected || undefined} style={selected ? { outline: "2px solid var(--mr-selected)", outlineOffset: -2 } : undefined}>
      <div className="mr-flag" />
      <div className="mr-qbody" style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
        <span style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 0 }}>
          <span className="mr-row" style={{ gap: 6 }}><strong className="mr-ink2">{/^Style:/.test(sessionTitle(s)) ? "Your restyle" : "Your bug report"}</strong><span className="mr-dim">/</span><span className="mr-ink2 mr-ellipsis">{plural(Object.keys(s.files).length, "file")} changed</span></span>
          <span className="mr-ask">{sessionTitle(s).replace(/^Fix: /, "Fixed: ").replace(/^Style: /, "Restyled: ")}</span>
          {state && state !== "applying" && <span style={{ color: "var(--mr-error)" }}>{state}</span>}
        </span>
        <button type="button" className="mr-key" onClick={onOpen}>Look first ↵</button>
        <Key tone="primary" onClick={() => void apply()} disabled={state === "applying"}>{state === "applying" ? "Applying…" : "Apply to my app"}</Key>
      </div>
    </div>
  );
}
