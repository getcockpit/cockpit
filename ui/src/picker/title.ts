import type { SessionState } from "../state/types";

// What to call a session (F3): the user's words, without the scaffolding the start picker and
// side threads add, cut at a word boundary.
export function cleanTitle(raw: string, max = 72): string {
  let t = raw.trim()
    .replace(/^Plan this with me before any code:\s*/i, "")
    .replace(/\.\s*Write the plan[\s\S]*$/i, "")
    .replace(/^Side thread about (?:the session )?"([^"]+)"[\s\S]*$/i, "About “$1”");
  t = t.split("\n")[0].trim();
  if (!t) return "Untitled";
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 12)).replace(/[,.;:]$/, "")}…`;
}

export const sessionTitle = (s: Pick<SessionState, "title">) => cleanTitle(s.title || "Untitled");
