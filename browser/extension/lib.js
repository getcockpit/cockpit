// Pure helpers for the overlay: selectors, rects, redaction targets. Injected before annotator.js
// into the extension's isolated world; also loaded by `bun test` (module.exports at the bottom).

(() => {
  const lib = {};

  const cssEscape = (s) => (globalThis.CSS?.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`));

  /** A short selector that finds `el` again: a test id, a unique id, else a tag/class path. */
  lib.selector = (el, doc = globalThis.document) => {
    const unique = (sel) => { try { return doc.querySelectorAll(sel).length === 1; } catch { return false; } };
    for (const a of ["data-testid", "data-test", "data-cy", "data-mr"]) {
      const v = el.getAttribute?.(a);
      if (v && unique(`[${a}="${v.replace(/"/g, '\\"')}"]`)) return `[${a}="${v}"]`;
    }
    if (el.id && unique(`#${cssEscape(el.id)}`)) return `#${cssEscape(el.id)}`;
    const parts = [];
    let cur = el;
    for (let depth = 0; cur && cur.nodeType === 1 && depth < 6; depth++) {
      const tag = cur.tagName.toLowerCase();
      if (tag === "html" || tag === "body") break;
      const classes = [...(cur.classList || [])].filter((c) => /^[a-zA-Z][\w-]*$/.test(c) && c.length < 30).slice(0, 2);
      let part = tag + classes.map((c) => `.${c}`).join("");
      const parent = cur.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      if (unique(parts.join(" > "))) return parts.join(" > ");
      cur = parent;
    }
    return parts.join(" > ");
  };

  /** Fields whose contents must never leave the page: blacked out in crops. */
  lib.SECRET_FIELDS = [
    "input[type=password]",
    "input[autocomplete^='cc-']",
    "input[autocomplete='one-time-code']",
    "input[name*='card' i]",
    "input[name*='cvv' i]",
    "input[name*='cvc' i]",
    "input[name*='otp' i]",
    "input[name*='ssn' i]",
  ].join(",");

  /** A rect from two drag corners. */
  lib.boxFrom = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });

  /** Whether two {x,y,w,h} rects overlap. */
  lib.intersects = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  /** The secret fields' viewport rects that touch the crop area (padded like the crop). */
  lib.redactRects = (area, rects, pad = 16) => {
    const padded = { x: area.x - pad, y: area.y - pad, w: area.w + pad * 2, h: area.h + pad * 2 };
    return rects.filter((r) => r.w > 0 && r.h > 0 && lib.intersects(padded, r));
  };

  /** "9 pins in 3 tabs" */
  lib.countLine = (pins, tabs) => `${pins} pin${pins === 1 ? "" : "s"}${tabs > 1 ? ` in ${tabs} tabs` : ""}`;

  /** The page's own text for an element: trimmed, one line, capped. Inputs give none (no values). */
  lib.textOf = (el) => {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return el.getAttribute("placeholder") || el.getAttribute("aria-label") || "";
    return String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 300);
  };

  /** The element's HTML with nothing typed or secret in it: values, hidden inputs and textarea
   *  contents go before it leaves the page (Cockpit redacts again before storing). Capped. */
  lib.safeHtml = (el, max = 4000) => {
    const c = el.cloneNode(true);
    const all = [c, ...c.querySelectorAll("*")];
    for (const n of all) {
      if (n.tagName === "SCRIPT") n.textContent = "";
      if (n.tagName === "TEXTAREA") n.textContent = "";
      if (n.tagName === "INPUT" && (n.getAttribute("type") || "").toLowerCase() === "hidden") n.removeAttribute("name");
      for (const a of ["value", "data-token", "data-secret", "data-key"]) n.removeAttribute?.(a);
    }
    // Shallow for big containers: the tag and its direct text are enough to find it.
    const html = c.outerHTML;
    return html.length > max ? html.slice(0, max) + "…" : html;
  };

  /** Moves item i of a list by d (−1 up, +1 down), returning a new list. */
  lib.move = (list, i, d) => {
    const j = i + d;
    if (j < 0 || j >= list.length) return list;
    const out = list.slice();
    [out[i], out[j]] = [out[j], out[i]];
    return out;
  };

  /** Whether a key event should toggle annotate mode: ⌥A outside text fields. */
  lib.isToggle = (e) => e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === "KeyA" && !lib.isEditable(e.target);

  lib.isEditable = (t) => !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ""));

  globalThis.__cockpitLib = lib;
  if (typeof module !== "undefined") module.exports = lib;
})();
