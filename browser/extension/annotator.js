// Cockpit annotations: the in-page overlay. Runs in the extension's isolated world inside a closed
// shadow root, so page scripts can't see it, call it, or press its buttons; only trusted (real)
// events count. Nothing is sent to a session until you press Confirm & send in the review.

(() => {
  if (globalThis.__cockpitOverlay) return globalThis.__cockpitOverlay.refresh();
  const L = globalThis.__cockpitLib;
  const C = { ink: "#15181b", ink3: "#545b61", tile: "#e4e7ea", base: "#d3d6d9", band: "#c3c7cb", needs: "#ffb300", error: "#c62828", sel: "#0e6e78", done: "#1e7a4c" };
  const ask = (msg) => chrome.runtime.sendMessage({ type: "call", msg });

  // Console errors from the moment the tab was linked (DOM error events reach the isolated world).
  const errors = [];
  const onErr = (e) => { if (errors.length < 20) errors.push(String(e.message || e.reason?.message || e.reason || "error").slice(0, 300) + (e.filename ? ` (${e.filename.split("/").pop()}:${e.lineno})` : "")); };
  addEventListener("error", onErr, true);
  addEventListener("unhandledrejection", onErr, true);

  const host = document.createElement("cockpit-annotations");
  host.setAttribute("data-mr", "browser-overlay");
  host.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>
    * { box-sizing: border-box; font: 13px/1.4 -apple-system, "Atkinson Hyperlegible Next", sans-serif; color: ${C.ink}; }
    .tray { position: fixed; right: 16px; bottom: 16px; width: 300px; background: ${C.tile}; border-radius: 2px; pointer-events: auto; box-shadow: 0 0 0 1px ${C.band}; }
    .head { display: flex; gap: 6px; align-items: center; padding: 8px; background: ${C.base}; }
    .m { display: inline-block; min-width: 18px; text-align: center; background: ${C.ink}; color: #fff; font-weight: 700; border-radius: 2px; padding: 0 3px; }
    .grow { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    button { border: 0; border-radius: 2px; padding: 5px 8px; background: ${C.band}; cursor: pointer; }
    button.go { background: ${C.ink}; color: #fff; }
    button.on { background: ${C.sel}; color: #fff; }
    .row { display: flex; gap: 6px; padding: 8px; align-items: center; flex-wrap: wrap; }
    .list { max-height: 180px; overflow: auto; padding: 0 8px 8px; }
    .pin { display: flex; gap: 6px; padding: 3px 0; cursor: pointer; }
    .hint { font-size: 11px; color: ${C.ink3}; padding: 0 8px 8px; }
    .hl { position: fixed; outline: 2px solid ${C.sel}; background: rgba(14,110,120,.08); pointer-events: none; }
    .mark { position: absolute; min-width: 20px; height: 20px; border-radius: 2px; background: ${C.ink}; color: #fff; font-weight: 700; font-size: 11px; text-align: center; line-height: 20px; pointer-events: auto; cursor: pointer; padding: 0 4px; }
    .mark.fixed { background: ${C.done}; } .mark.open { background: ${C.needs}; color: ${C.ink}; } .mark.wontfix { background: ${C.ink3}; }
    .box { position: absolute; outline: 2px dashed ${C.ink3}; pointer-events: none; }
    .bubble { position: fixed; width: 260px; background: ${C.tile}; padding: 8px; pointer-events: auto; box-shadow: 0 0 0 1px ${C.band}; border-radius: 2px; }
    textarea { width: 100%; min-height: 54px; border: 0; border-radius: 2px; padding: 6px; background: #fff; resize: vertical; }
    .sheet { position: fixed; top: 5vh; left: 10vw; right: 10vw; max-height: 90vh; background: ${C.tile}; pointer-events: auto; display: flex; flex-direction: column; box-shadow: 0 0 0 100vmax rgba(21,24,27,.35); border-radius: 2px; }
    .sheet .body { flex: 1; overflow: auto; padding: 12px; }
    .sheet h2 { font-size: 15px; margin: 0; padding: 12px; background: ${C.base}; }
    .tab { margin: 0 0 12px; } .tab > b { display: block; padding: 4px 0; }
    .page { font-size: 11px; color: ${C.ink3}; padding: 2px 0 4px; }
    .item { display: grid; grid-template-columns: 24px 120px 1fr auto; gap: 8px; padding: 6px; background: ${C.base}; margin: 0 0 4px; align-items: start; border-radius: 2px; }
    .item img { max-width: 120px; max-height: 80px; display: block; }
    .item code { font: 11px ui-monospace, monospace; color: ${C.ink3}; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .err { color: ${C.error}; }
    .catcher { position: fixed; inset: 0; pointer-events: auto; cursor: crosshair; }
  </style>`;
  const layer = document.createElement("div");
  const marks = document.createElement("div");
  marks.style.cssText = "position: absolute; left: 0; top: 0;";
  root.append(marks, layer);
  (document.body || document.documentElement).append(host);

  const el = (tag, props = {}, ...kids) => {
    const e = Object.assign(document.createElement(tag), props);
    for (const k of kids) if (k != null && k !== false) e.append(k);
    return e;
  };
  // Buttons act on real clicks only: a page script can't forge a pin or a confirm.
  const btn = (text, fn, cls = "") => {
    const b = el("button", { className: cls, textContent: text });
    b.addEventListener("click", (e) => { if (e.isTrusted) fn(e); });
    return b;
  };

  let state = null;
  let annotating = false;
  let tray = el("div");
  let captureNote = "";
  // The open review sheet's keys (Esc cancels, ⌘↵ confirms), while it's open.
  let sheetKeys = null;

  async function refresh() {
    try {
      state = await ask({ type: "tab_state", url: location.href });
    } catch { return; }
    if (!state || state.error || !state.linked || state.blocked) return teardown();
    render();
  }

  function render() {
    const s = state;
    const list = el("div", { className: "list" }, ...s.open.map((p) => {
      const row = el("div", { className: "pin" }, el("b", { textContent: `${p.n}.` }), el("span", { className: "grow", textContent: p.note || "(no note)" }), p.url !== location.href ? el("span", { className: "hint", textContent: p.tab_title || "other tab" }) : null);
      row.addEventListener("click", (e) => { if (e.isTrusted) chrome.runtime.sendMessage({ type: "focus_tab", tab: p.tab }); });
      return row;
    }));
    const next = el("div", { className: "tray", "data-mr": "browser-tray" },
      el("div", { className: "head" }, el("span", { className: "m", textContent: s.linked.marker }), el("span", { className: "grow", textContent: `${s.linked.title} · ${L.countLine(s.count.pins, s.count.tabs)}` }), Object.assign(btn("×", unlink), { title: `Unlink this tab from ${s.linked.title}` })),
      el("div", { className: "row" },
        btn(annotating ? "Annotating… (Esc)" : "Annotate (⌥A)", () => setAnnotating(!annotating), annotating ? "on" : ""),
        s.count.pins ? btn(`Review & send ${s.count.pins}`, review, "go") : null,
        s.carryable && !s.count.pins ? btn(`Carry ${s.carryable} open`, async () => { await ask({ type: "carry" }); refresh(); }) : null,
      ),
      s.open.length ? list : null,
      captureNote ? el("div", { className: "hint", textContent: captureNote }) : null,
      annotating && !s.count.pins && !captureNote ? el("div", { className: "hint", textContent: "Click anything on the page, or drag a box. Esc lets you use the page." }) : null,
    );
    tray.replaceWith(next);
    tray = next;
    if (!tray.isConnected) layer.append(tray);
    drawMarks();
  }

  function drawMarks() {
    marks.replaceChildren();
    for (const p of state.page || []) {
      const r = p.rect || {};
      const m = el("div", { className: `mark ${p.sent ? p.status || "" : ""}`, textContent: String(p.n), title: [p.note, p.reply && `Reply: ${p.reply}`].filter(Boolean).join("\n") });
      m.style.left = `${(r.px ?? r.x ?? 0) - 10}px`;
      m.style.top = `${(r.py ?? r.y ?? 0) - 10}px`;
      m.style.position = "absolute";
      if (p.reply || p.note) m.addEventListener("click", (e) => { if (e.isTrusted) bubble(m.getBoundingClientRect(), el("div", {}, el("b", { textContent: `${p.n}. ${p.status || (p.sent ? "sent" : "open")}` }), el("div", { textContent: p.note }), p.reply ? el("div", { textContent: `Agent: ${p.reply}` }) : null, el("div", { className: "row" }, btn("Close", closeBubble)))); });
      if (p.kind === "box" && !p.sent && r.w) {
        const b = el("div", { className: "box" });
        Object.assign(b.style, { left: `${r.px ?? r.x}px`, top: `${r.py ?? r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
        marks.append(b);
      }
      marks.append(m);
    }
    // Page coordinates: markers scroll with the page.
    marks.style.transform = `translate(${-scrollX}px, ${-scrollY}px)`;
  }
  addEventListener("scroll", () => state && (marks.style.transform = `translate(${-scrollX}px, ${-scrollY}px)`), { passive: true });

  // ---- annotate mode: hover highlight, click an element or drag a box, then a note ----
  const hl = el("div", { className: "hl" });
  const catcher = el("div", { className: "catcher" });
  let start = null, boxEl = null;

  function setAnnotating(on) {
    annotating = on;
    hl.remove(); catcher.remove(); closeBubble();
    if (on) layer.prepend(catcher, hl);
    if (state) render();
  }

  const under = (x, y) => {
    catcher.style.pointerEvents = "none";
    const t = document.elementFromPoint(x, y);
    catcher.style.pointerEvents = "auto";
    return t && t !== host ? t : null;
  };

  catcher.addEventListener("mousemove", (e) => {
    if (!e.isTrusted) return;
    if (start) {
      const r = L.boxFrom(start, { x: e.clientX, y: e.clientY });
      if (r.w + r.h > 6) {
        hl.style.display = "none";
        boxEl ||= layer.appendChild(el("div", { className: "hl" }));
        Object.assign(boxEl.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
      }
      return;
    }
    if (bubbleEl) return;
    const t = under(e.clientX, e.clientY);
    if (!t) return;
    const r = t.getBoundingClientRect();
    Object.assign(hl.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, display: "block" });
  });
  catcher.addEventListener("mousedown", (e) => { if (e.isTrusted && e.button === 0) start = { x: e.clientX, y: e.clientY }; });
  catcher.addEventListener("mouseup", (e) => {
    if (!e.isTrusted || !start) return;
    const r = L.boxFrom(start, { x: e.clientX, y: e.clientY });
    const s = start;
    start = null;
    boxEl?.remove(); boxEl = null;
    if (r.w + r.h > 6) return note({ kind: "box", rect: r });
    const t = under(s.x, s.y);
    if (!t) return;
    const b = t.getBoundingClientRect();
    note({ kind: "element", target: t, rect: { x: b.left, y: b.top, w: b.width, h: b.height } });
  });

  let bubbleEl = null;
  function closeBubble() { if (bubbleEl) hl.style.display = "none"; bubbleEl?.remove(); bubbleEl = null; }
  function bubble(at, content) {
    closeBubble();
    bubbleEl = el("div", { className: "bubble" }, content);
    bubbleEl.style.left = `${Math.min(innerWidth - 276, Math.max(8, at.x))}px`;
    bubbleEl.style.top = `${Math.min(innerHeight - 140, at.y + (at.height || at.h || 0) + 8)}px`;
    layer.append(bubbleEl);
  }

  function note(pick) {
    // The picked element or box stays outlined while you write.
    Object.assign(hl.style, { left: `${pick.rect.x}px`, top: `${pick.rect.y}px`, width: `${pick.rect.w}px`, height: `${pick.rect.h}px`, display: "block" });
    const ta = el("textarea", { placeholder: "What's wrong here? (Enter to pin, Esc to cancel)" });
    const save = async () => {
      const text = ta.value.trim();
      closeBubble();
      await addPin(pick, text);
    };
    ta.addEventListener("keydown", (e) => {
      if (!e.isTrusted) return;
      e.stopPropagation();
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); save(); }
      if (e.key === "Escape") closeBubble();
    });
    bubble(pick.rect, el("div", {}, ta, el("div", { className: "row" }, btn("Pin", save, "go"), btn("Cancel", closeBubble))));
    ta.focus();
  }

  async function addPin(pick, noteText) {
    const r = pick.rect;
    const secrets = [...document.querySelectorAll(L.SECRET_FIELDS)].map((f) => { const b = f.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; });
    // Hide the overlay for the shot; crops need the ⌥⇧A gesture on this page load (activeTab).
    host.style.visibility = "hidden";
    await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
    let shot = {};
    try {
      shot = await chrome.runtime.sendMessage({ type: "capture", rect: r, dpr: devicePixelRatio, redact: L.redactRects(r, secrets) });
    } catch { shot = {}; }
    host.style.visibility = "";
    captureNote = shot?.crop ? "" : "No crop: press ⌥⇧A on this page to allow screenshots, then pin again.";
    const pin = {
      kind: pick.kind,
      selector: pick.target ? L.selector(pick.target) : "",
      text: pick.target ? L.textOf(pick.target) : "",
      html: pick.target ? L.safeHtml(pick.target) : "",
      rect: { x: r.x, y: r.y, w: r.w, h: r.h, px: r.x + scrollX, py: r.y + scrollY },
      url: location.href,
      note: noteText,
      crop: shot?.crop,
      thumb: shot?.thumb,
      redactions: shot?.redactions || 0,
      console: errors.slice(-5),
    };
    const res = await ask({ type: "pin", pin });
    if (res?.error) captureNote = res.message || res.error;
    refresh();
  }

  // ---- review & confirm: the only way anything is sent ----
  async function review() {
    setAnnotating(false);
    const b = await ask({ type: "batch" });
    if (b.error) return;
    let order = b.tabs.flatMap((t) => t.pages.flatMap((p) => p.pins.map((x) => x.id)));
    const byId = Object.fromEntries(b.tabs.flatMap((t) => t.pages.flatMap((p) => p.pins.map((x) => [x.id, { ...x, tab: t.title, url: p.url }]))));
    const batchNote = el("textarea", { placeholder: "A note for the whole batch (optional)", value: b.note || "" });
    const status = el("div", { className: "row" });
    const body = el("div", { className: "body" });
    const send = btn(`Confirm & send ${b.count} pin${b.count === 1 ? "" : "s"} (⌘↵)`, confirm, "go");
    const close = () => { sheet.remove(); sheetKeys = null; };
    const sheet = el("div", { className: "sheet", "data-mr": "browser-review" },
      el("h2", {}, `Send ${b.count} pin${b.count === 1 ? "" : "s"} from ${b.tab_count} tab${b.tab_count === 1 ? "" : "s"} to `, el("span", { className: "m", textContent: b.marker }), ` ${b.title}`),
      body,
      el("div", { className: "row" }, batchNote),
      el("div", { className: "row" }, send, btn("Cancel (Esc)", close)),
      status,
    );
    const draw = () => {
      body.replaceChildren(...order.map((id, i) => {
        const p = byId[id];
        const n = el("textarea", { value: p.note });
        n.addEventListener("change", (e) => { if (!e.isTrusted) return; p.note = n.value; ask({ type: "pin_edit", pin: id, note: n.value }); });
        return el("div", { className: "item" },
          el("b", { textContent: `${i + 1}.` }),
          p.thumb ? el("img", { src: p.thumb }) : el("span", { className: "hint", textContent: "no crop" }),
          el("div", {}, el("code", { textContent: `${p.tab} · ${p.url}` }), el("code", { textContent: p.kind === "box" ? "[box]" : p.selector }), p.redactions ? el("code", { textContent: `${p.redactions} field(s) redacted` }) : null, n),
          el("div", {}, btn("↑", () => { order = L.move(order, i, -1); draw(); }), btn("↓", () => { order = L.move(order, i, 1); draw(); }), btn("Remove", async () => { await ask({ type: "pin_remove", pin: id }); order = order.filter((x) => x !== id); draw(); refresh(); })),
        );
      }));
      send.textContent = `Confirm & send ${order.length} pin${order.length === 1 ? "" : "s"} (⌘↵)`;
      send.disabled = !order.length;
    };
    async function confirm() {
      send.disabled = true;
      const r = await ask({ type: "confirm", session: b.session, note: batchNote.value, order });
      if (r.error) { send.disabled = false; return status.replaceChildren(el("span", { className: "err", textContent: r.message || r.error })); }
      close();
      captureNote = `Sent ${r.sent} pin${r.sent === 1 ? "" : "s"} to ${r.title}.`;
      refresh();
    }
    draw();
    layer.append(sheet);
    sheetKeys = (e) => {
      if (e.key === "Escape") { e.preventDefault(); close(); }
      else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !send.disabled) { e.preventDefault(); confirm(); }
      else return false;
      return true;
    };
  }

  async function unlink() {
    await ask({ type: "unlink" });
    teardown();
  }

  function teardown() {
    removeEventListener("keydown", onKey, true);
    removeEventListener("error", onErr, true);
    removeEventListener("unhandledrejection", onErr, true);
    chrome.runtime.onMessage.removeListener(onMsg);
    host.remove();
    delete globalThis.__cockpitOverlay;
  }

  function onKey(e) {
    if (!e.isTrusted) return;
    if (sheetKeys) { if (sheetKeys(e)) e.stopPropagation(); return; }
    if (L.isToggle(e)) { e.preventDefault(); e.stopPropagation(); setAnnotating(!annotating); }
    else if (e.key === "Escape" && annotating && !bubbleEl) setAnnotating(false);
  }
  addEventListener("keydown", onKey, true);

  function onMsg(msg) {
    if (msg.type === "refresh") refresh();
    // Opened from "Annotate a page…" in Cockpit: ready to click, no extra step.
    if (msg.type === "annotate" && !annotating) setAnnotating(true);
    if (msg.type === "unlinked") teardown();
    if (msg.type === "hide") host.style.visibility = "hidden";
    if (msg.type === "show") host.style.visibility = "";
  }
  chrome.runtime.onMessage.addListener(onMsg);

  globalThis.__cockpitOverlay = { refresh };
  refresh();
})();
