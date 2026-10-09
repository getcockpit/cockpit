import { useMemo } from "react";
import { DecisionCard, type Answer } from "../components";
import { pickDecision } from "../picker/pick";
import { api } from "../state/store";
import type { PendingAsk, SessionState } from "../state/types";

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
          <strong className="mr-ink2">{s.cwd.split("/").filter(Boolean).pop() ?? s.cwd}</strong>
          <span className="mr-dim">/</span>
          <span className="mr-ink2 mr-ellipsis">{s.title.slice(0, 80)}</span>
        </span>
        <DecisionCard spec={spec} onAnswer={answer} />
      </div>
    </div>
  );
}
