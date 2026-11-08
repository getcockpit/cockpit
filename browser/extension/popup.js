// The ⌥⇧A / toolbar popup: link this tab to a session, or show who it already belongs to.
// Opening it grants activeTab for this tab, which is all the access the overlay gets.

const root = document.getElementById("root");
const LOCALHOST = ["http://localhost/*", "http://127.0.0.1/*"];
const ask = (msg) => chrome.runtime.sendMessage(msg);

function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids) e.append(k);
  return e;
}

function show(...nodes) {
  root.replaceChildren(...nodes);
}

function explain(error) {
  if (error === "not_set_up") return "Cockpit's browser link isn't set up. In Cockpit: Settings → Browser → Set up browser.";
  if (error === "cockpit_not_running" || error === "timeout") return "Open Cockpit first, then try again.";
  return error;
}

async function main() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/^https?:/.test(tab.url)) return show(el("p", { className: "muted", textContent: "Only web pages can be annotated." }));
  const st = await ask({ type: "popup_state", tabId: tab.id, url: tab.url });
  if (st.error) return show(el("p", { className: "err", textContent: explain(st.error) }));
  if (st.blocked) return show(el("p", { className: "err", textContent: "This site is on Cockpit's block list (Settings → Browser)." }));
  if (st.linked) {
    // A tab belongs to one session; to move it, unlink first.
    const unlink = el("button", { className: "ghost", textContent: "Unlink" });
    unlink.onclick = async () => { await ask({ type: "popup_unlink", tabId: tab.id }); window.close(); };
    return show(
      el("h1", {}, "Already linked to ", el("span", { className: "m", textContent: st.linked.marker }), " ", st.linked.title),
      el("p", { className: "muted", textContent: "The overlay is on the page: ⌥A to annotate. To link it to another session, unlink it first." }),
      el("div", { className: "row" }, unlink),
    );
  }
  if (!st.sessions.length) return show(el("p", { className: "muted", textContent: "No Cockpit session is running. Start one, then link this tab." }));
  const list = st.sessions.map((s) => el("label", { className: "s" },
    el("input", { type: "radio", name: "s", value: s.id, checked: s.suggested }),
    el("span", { className: "m", textContent: s.marker }),
    el("span", { textContent: s.title + (s.serves ? " · serves this page" : "") }),
  ));
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(tab.url);
  const auto = el("input", { type: "checkbox", checked: !st.localPermission });
  const go = el("button", { textContent: "Link" });
  const msg = el("p", { className: "err" });
  const link = async () => {
    const session = root.querySelector("input[name=s]:checked")?.value;
    if (!session) return;
    // Asked in the click itself: Chrome only grants permissions from a user gesture.
    if (local && auto.checked && !st.localPermission) await chrome.permissions.request({ origins: LOCALHOST }).catch(() => false);
    const r = await ask({ type: "popup_link", tabId: tab.id, url: tab.url, title: tab.title || "", session });
    if (r.error) return (msg.textContent = r.message || explain(r.error));
    window.close();
  };
  go.onclick = link;
  document.addEventListener("keydown", (e) => { if (e.key === "Enter") link(); });
  show(
    el("h1", { textContent: "Link this tab to a session" }),
    ...list,
    local && !st.localPermission ? el("label", { className: "hint" }, auto, " Keep localhost tabs linked across reloads") : "",
    el("div", { className: "row" }, go, el("span", { className: "hint", textContent: "Enter" })),
    msg,
  );
}

main().catch((e) => show(el("p", { className: "err", textContent: explain(String(e.message || e)) })));
