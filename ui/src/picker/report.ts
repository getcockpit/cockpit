// Report-shaped replies (MR-56): Claude's Markdown split into a lead decision, sections with
// items and a closing Next line. Plain parsing, no model. Rendered by components/Turn.tsx and
// used by the needs-you queue to ask the real decision instead of echoing the Next line.

export type Item = { title: string | null; detail: string; time: string | null; sub: string[] };
export type Section = { heading: string; tone: "done" | "todo" | "you" | "info"; intro: string[]; items: Item[]; outro: string[]; ordered: boolean };
export type Report = { lead: string[]; decision: string | null; sections: Section[]; next: string | null };

const TIME = /\b(?:about|~|around|roughly)\s*(\d+(?:[.,]\d+)?(?:\s*[–-]\s*\d+(?:[.,]\d+)?)?\s*(?:min(?:ute)?s?|h(?:ours?|rs?)?|days?|weeks?))\b/i;

function toneOf(heading: string): Section["tone"] {
  if (/only you|manual|you (need|have) to|your (part|turn)|needs? you|decide/i.test(heading)) return "you";
  if (/\b(do now|to ?do|next steps?|fix(es)?|plan|steps|follow-?ups?|remaining|left)\b/i.test(heading)) return "todo";
  if (/\b(done|shipped|finished|completed|where things stand|status)\b/i.test(heading)) return "done";
  return "info";
}

function parseItem(raw: string): Item {
  const m = raw.match(/^\*\*(.+?)\*\*[:.]?\s*(.*)$/s);
  const title = m ? m[1].replace(/[:.]$/, "") : null;
  const detail = (m ? m[2] : raw).trim();
  const t = (title ?? "") + " " + detail;
  const time = t.match(TIME)?.[1] ?? null;
  return { title, detail, time, sub: [] };
}

/** Splits a reply into lead, sections and the closing Next line; null when it isn't report-shaped. */
export function parseReport(text: string): Report | null {
  const lines = text.replace(/\r/g, "").split("\n");
  const headings = lines.filter((l) => /^#{1,4}\s/.test(l)).length;
  const listItems = lines.filter((l) => /^\s*(\d+[.)]|[-*])\s+/.test(l)).length;
  if (headings < 1 || listItems < 3 || text.length < 300) return null;

  const r: Report = { lead: [], decision: null, sections: [], next: null };
  let cur: Section | null = null;
  for (const l of lines) {
    const h = l.match(/^#{1,4}\s+(.*)$/);
    if (h) { cur = { heading: h[1].replace(/\*\*/g, "").trim(), tone: toneOf(h[1]), intro: [], items: [], outro: [], ordered: false }; r.sections.push(cur); continue; }
    if (/^\s*Next:/i.test(l)) { r.next = l.replace(/^\s*Next:\s*/i, "").trim(); continue; }
    const li = l.match(/^(\s*)(\d+[.)]|[-*])\s+(.*)$/);
    if (li && cur) {
      if (li[1].length >= 2 && cur.items.length) cur.items[cur.items.length - 1].sub.push(li[3]);
      else { cur.items.push(parseItem(li[3])); cur.ordered ||= /\d/.test(li[2]); }
      continue;
    }
    if (!l.trim()) continue;
    if (cur && cur.items.length && /^\s{2,}\S/.test(l)) { cur.items[cur.items.length - 1].detail += " " + l.trim(); continue; }
    // Text after a section's items (a table, a closing note) stays after them.
    if (cur) (cur.items.length ? cur.outro : cur.intro).push(l.trim()); else r.lead.push(l.trim());
  }
  // A lead that opens with a bold question is the decision this turn is waiting on.
  const q = r.lead.find((p) => /^\*\*[^*]+\?\*\*/.test(p) || /^\*\*[^*]*decision[^*]*\*\*/i.test(p));
  if (q) { r.decision = q.match(/^\*\*([^*]+)\*\*/)?.[1] ?? null; r.lead = r.lead.map((p) => (p === q ? p.replace(/^\*\*[^*]+\*\*\s*/, "") : p)).filter(Boolean); }
  return r.sections.length ? r : null;
}

