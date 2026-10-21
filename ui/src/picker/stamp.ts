// When things happened (MR-182): the clock beside each transcript row, the day dividers between
// them, and the full date on hover. Local time, the user's own locale.

const DAY = 86_400_000;

/** "14:32" (or "2:32 PM", per locale). */
export function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** The clock split from its AM/PM (empty in 24-hour locales): the gutter says the period only when
 *  it changes, so a column of 12-hour clocks doesn't repeat "AM" on every row. */
export function clockParts(at: number): { time: string; period: string } {
  const parts = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(at));
  return {
    time: parts.filter((p) => p.type !== "dayPeriod").map((p) => p.value).join("").trim(),
    period: parts.find((p) => p.type === "dayPeriod")?.value ?? "",
  };
}

/** "Wed 21 Oct 2026, 14:32:05": the tooltip, so the exact moment is one hover away. */
export function fullTime(at: number): string {
  return new Date(at).toLocaleString([], { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** A local calendar day, to tell when a divider is due. */
export function dayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** A local minute: rows in the same minute as the one above don't repeat its clock. */
export function minuteKey(at: number): string {
  const d = new Date(at);
  return `${dayKey(at)} ${d.getHours()}:${d.getMinutes()}`;
}

/** "Today", "Yesterday", "Mon 19 Oct", or "19 Oct 2025" in another year. */
export function dayLabel(at: number, now: number): string {
  if (dayKey(at) === dayKey(now)) return "Today";
  if (dayKey(at) === dayKey(now - DAY)) return "Yesterday";
  const d = new Date(at);
  if (d.getFullYear() !== new Date(now).getFullYear()) return d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
  return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
}

/** "14:32" today, "Yesterday 14:32", "Mon 19 Oct 14:32" before that. */
export function whenLabel(at: number, now: number): string {
  const day = dayLabel(at, now);
  return day === "Today" ? clockTime(at) : `${day} ${clockTime(at)}`;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The ms a ULID (an event id) was made at: its first 10 characters. null if it isn't one. */
export function ulidTime(id: string): number | null {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(id)) return null;
  let ms = 0;
  for (const c of id.slice(0, 10).toUpperCase()) ms = ms * 32 + CROCKFORD.indexOf(c);
  return ms;
}

/** A ULID-shaped id made at `ms` (its random half zeroed): the demo's block ids, and tests. */
export function ulidAt(ms: number): string {
  let head = "", n = Math.max(0, Math.floor(ms));
  for (let i = 0; i < 10; i++) { head = CROCKFORD[n % 32] + head; n = Math.floor(n / 32); }
  return `${head}${"0".repeat(16)}`;
}
