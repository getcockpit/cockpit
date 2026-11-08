// Stands in for chrome.runtime in the main world, so the overlay's own code runs unchanged.
window.__calls = [];
let pins = [];
Element.prototype.__attach = Element.prototype.attachShadow;
Element.prototype.attachShadow = function (o) { const r = this.__attach(o); window.__root = r; return r; };
window.chrome = { runtime: { onMessage: { addListener() {}, removeListener() {} }, sendMessage: async (m) => {
  window.__calls.push(m);
  if (m.type === "capture") return { crop: "data:image/png;base64,AAAA", thumb: null, redactions: m.redact.length };
  const t = m.msg?.type;
  if (t === "tab_state") return { linked: { session: "A", title: "settings redesign", marker: "S" }, blocked: false, count: { pins: pins.length, tabs: 1 }, open: pins.map((p, i) => ({ id: "p" + i, n: i + 1, note: p.note, url: location.href })), page: [], carryable: 0 };
  if (t === "pin") { pins.push(m.msg.pin); return { pin: "p" + (pins.length - 1), n: pins.length }; }
  if (t === "batch") return { session: "A", title: "settings redesign", marker: "S", count: pins.length, tab_count: 1, note: "", tabs: [{ tab: "c:1", title: "Settings", pages: [{ url: location.href, pins: pins.map((p, i) => ({ id: "p" + i, n: i + 1, kind: p.kind, selector: p.selector, note: p.note, redactions: p.redactions, thumb: null })) }] }] };
  if (t === "confirm") return { sent: pins.length, title: "settings redesign" };
  return { ok: true };
} } };
