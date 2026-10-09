// Shortcuts match the physical key, not the typed character, so they work on any keyboard layout
// (with Ukrainian active, ⌘K types "л" and e.key never equals "k").
export function keyOf(e: { code: string; key: string }): string {
  const c = e.code;
  if (/^Key[A-Z]$/.test(c)) return c.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(c)) return c.slice(5);
  const named: Record<string, string> = { Comma: ",", Period: ".", Space: " ", Slash: "/" };
  return named[c] ?? e.key;
}
