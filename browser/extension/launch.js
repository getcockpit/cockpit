// The Cockpit-launched browser: stands in for chrome.runtime so annotator.js runs unchanged.
// Injected by Cockpit over the DevTools pipe into an isolated world named "cockpit", where the
// __cockpitSend binding exists; the page's own world has neither. Not used by the extension.

(() => {
  if (typeof __cockpitSend !== "function" || globalThis.__cockpitShim || !/^(https?|file):$/.test(location.protocol)) return;
  globalThis.__cockpitShim = true;
  const send = __cockpitSend;
  const pending = new Map();
  const listeners = new Set();
  let seq = 0;
  globalThis.__cockpitReply = (id, r) => { const f = pending.get(id); pending.delete(id); f?.(r); };
  globalThis.__cockpitPush = (m) => { for (const f of listeners) f(m); };
  const ask = (msg) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); send(JSON.stringify({ id, msg })); });

  /** Black boxes over secret fields while the shot is taken, in a closed root of their own. */
  async function capture(m) {
    const host = document.createElement("cockpit-redact");
    host.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;";
    const root = host.attachShadow({ mode: "closed" });
    for (const r of m.redact || []) {
      const b = document.createElement("div");
      b.style.cssText = `position: fixed; left: ${r.x}px; top: ${r.y}px; width: ${r.w}px; height: ${r.h}px; background: #000;`;
      root.append(b);
    }
    (document.body || document.documentElement).append(host);
    await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
    try {
      return await ask({ ...m, rect: { ...m.rect, sx: scrollX, sy: scrollY, dpr: devicePixelRatio } });
    } finally {
      host.remove();
    }
  }

  const runtime = {
    sendMessage: (m) => (m.type === "capture" ? capture(m) : ask(m)),
    onMessage: { addListener: (f) => listeners.add(f), removeListener: (f) => listeners.delete(f) },
  };
  globalThis.chrome = Object.assign(globalThis.chrome || {}, { runtime });
})();
