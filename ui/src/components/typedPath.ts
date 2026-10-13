// Typed paths in the folder picker: `~`, `~/x`, `/x`, `.`, `..`, `./x` and `../x`, resolved against
// the current folder and normalised (`a/./b/../c` → `a/c`). Anything else is filter text (null).
// Paths under home keep their `~` form; the core expands it when a session starts.

export function resolveTyped(input: string, base: string, home: string): string | null {
  const t = input.trim();
  if (!/^(~(\/|$)|\/|\.\.?(\/|$))/.test(t)) return null;
  const full = t.startsWith(".") ? `${base.replace(/\/+$/, "") || "/"}/${t}` : t;
  const tilde = full === "~" || full.startsWith("~/");
  let root = tilde ? "~" : "";
  const out: string[] = [];
  for (const p of (tilde ? full.slice(1) : full).split("/")) {
    if (!p || p === ".") continue;
    if (p !== "..") { out.push(p); continue; }
    if (out.length) out.pop();
    else if (root === "~" && home) {
      // Climbing above home: switch to the absolute form and keep going.
      out.push(...home.split("/").filter(Boolean));
      out.pop();
      root = "";
    }
  }
  return root === "~" ? (out.length ? `~/${out.join("/")}` : "~") : `/${out.join("/")}`;
}
