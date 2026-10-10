import type { SessionState } from "../state/types";

// What to call a session (F3): the user's words, without the scaffolding the start picker and
// side threads add, cut at a word boundary.
export function cleanTitle(raw: string, max = 72): string {
  let t = raw.trim()
    .replace(/^Plan this with me before any code:\s*/i, "")
    .replace(/\.\s*Write the plan[\s\S]*$/i, "")
    .replace(/^Side thread about (?:the session )?"([^"]+)"[\s\S]*$/i, "About “$1”")
    .replace(/^God-mode mark[\s\S]*?Their note: ([^\n]*)[\s\S]*$/, "Fix: $1")
    .replace(/^Restyle the app: ([^\n]*)[\s\S]*$/, "Style: $1");
  t = t.split("\n")[0].trim();
  if (!t) return "Untitled";
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 12)).replace(/[,.;:]$/, "")}…`;
}

const prRef = (t: string) => { const m = t.match(/(?:pull\/|#|\s)(\d{1,7})\b/); return m ? `#${m[1]}` : ""; };

/** A session's display title: your rename, else (for Review and Address) the PR, using its own
 *  title once the flow has reported it, else what Claude says the thread is about (title_set),
 *  else your first prompt. Never the raw slash command. */
export function sessionTitle(s: Pick<SessionState, "title"> & Partial<Pick<SessionState, "review" | "address" | "name" | "autoTitle">>): string {
  if (s.name) return cleanTitle(s.name);
  const raw = (s.title || "").trim();
  if (/^\/review\b/.test(raw)) { const o = s.review?.overview; return cleanTitle(`Review ${o?.pr ?? prRef(raw)}${o?.title ? `: ${o.title}` : ""}`.trim()); }
  if (/^\/pr-address\b/.test(raw)) return cleanTitle(`Address ${s.address?.list?.pr ?? prRef(raw)} comments`.replace(/\s+/g, " "));
  return cleanTitle(s.autoTitle || raw || "Untitled");
}

/** "1 file", "3 files": counts in copy always agree in number. */
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : /(s|x|ch|sh)$/.test(word) ? "es" : "s"}`;
