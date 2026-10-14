// Shortcuts per platform (MR-133): the code and the copy say ⌘ ⌥ ⇧; on Linux and Windows the
// command key is Ctrl and labels read "Ctrl+Shift+D", "Ctrl-click". Every shortcut handler asks
// `modKey(e)` and every label goes through `keyLabel`, so nothing else checks the platform.

type Nav = { platform?: string; userAgentData?: { platform?: string } };

/** Unknown (no navigator) counts as a Mac, the labels the code is written in. Tests pin it with setMac. */
export function detect(nav: Nav | undefined = (globalThis as { navigator?: Nav }).navigator): boolean {
  const p = nav?.userAgentData?.platform || nav?.platform || "";
  return p === "" || /mac|iphone|ipad/i.test(p);
}

let mac = detect();

export function isMac(): boolean { return mac; }

/** Tests: force a platform (true = Mac, false = Linux/Windows), or null to detect again. */
export function setMac(v: boolean | null) { mac = v ?? detect(); }

/** The command modifier is held: ⌘ on a Mac, Ctrl elsewhere. Off a Mac, plain Ctrl inside the
 *  terminal belongs to the shell (Ctrl-R, Ctrl-K, Ctrl-T…); Ctrl+Shift shortcuts still reach Cockpit. */
export function modKey(e: { metaKey: boolean; ctrlKey: boolean; shiftKey?: boolean; target?: EventTarget | null }): boolean {
  if (mac) return e.metaKey;
  if (!e.ctrlKey) return false;
  const t = e.target as Element | null | undefined;
  return !!e.shiftKey || !t?.closest?.(".xterm");
}

const NAME: Record<string, string> = { "⌃": "Ctrl", "⌘": "Ctrl", "⌥": "Alt", "⇧": "Shift" };
const ORDER = ["Ctrl", "Alt", "Shift"];

/** "⌘⇧D" → "Ctrl+Shift+D", "⌘-click" → "Ctrl-click", "⌘↵" → "Ctrl+Enter" off a Mac; unchanged on one.
 *  Works on whole sentences ("Open Builds (⌘⇧B) for the log."). */
export function keyLabel(text: string): string {
  if (mac) return text;
  return text.replace(/([⌃⌥⇧⌘]+)(?: (Space)|(-click|↵|Space|Tab|[^\s)·]))?/g, (_m, mods: string, spaced?: string, key?: string) => {
    const names = ORDER.filter((n) => [...mods].some((g) => NAME[g] === n));
    const k = spaced ?? key;
    if (!k || k === "-click") return names.join("+") + (k ?? "");
    return [...names, k === "↵" ? "Enter" : k].join("+");
  });
}
