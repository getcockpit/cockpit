import { useMemo } from "react";
import { DecisionCard, type Answer } from "../components";
import { pickDecision } from "../picker/pick";
import { api } from "../state/store";
import type { PendingAsk, SessionState } from "../state/types";

// A needs-you row: where it's from (project / session as context, then the ask), plus the card.
export function AskRow({ s, a }: { s: SessionState; a: PendingAsk }) {
  const { spec } = useMemo(() => pickDecision(a), [a]);
  const answer = (x: Answer) => {
    const decision =
      x.kind === "deny" ? { behavior: "deny", message: x.note ?? "The user denied this." }
      : x.kind === "answer" ? { behavior: "allow", updatedInput: { ...a.input, answers: x.answers } }
      : { behavior: "allow", updatedInput: a.input, ...(x.always && a.kind === "permission" && a.suggestions ? { updatedPermissions: a.suggestions } : {}) };
    void api.respond(s.id, a.requestId, decision);
  };
  return (
    <div className="mr-qrow">
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
