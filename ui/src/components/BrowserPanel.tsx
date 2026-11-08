import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { listen } from "../state/listen";
import { Key } from ".";
import { shortError } from "./ErrorLine";

// Browser annotations (working doc "Browser annotations"): the Cockpit side of the extension.
// A session's linked tabs as chips in Focus, the review sheet mirrored from the page (Confirm &
// send works from either), and Settings → Browser. State lives in the core (browser.rs); this
// asks it again whenever a browser.* event lands.

export type BrowserLink = { tab: string; session: string; url: string; title: string; mode: string };
type SessionBrowser = { links: BrowserLink[]; pins: number; carryable: number };
type ReviewPin = { id: string; n: number; kind: string; selector: string; text: string; note: string; redactions: number; url: string; thumb: string | null; unlinked: boolean };
type Review = { session: string; title: string; marker: string; count: number; tab_count: number; note: string; tabs: { tab: string; title: string; pages: { url: string; pins: ReviewPin[] }[] }[]; error?: string; message?: string };
type Status = { installed: boolean; connected: number; launched: boolean; ext_id: string; extension_dir: string; links: (BrowserLink & { session_title: string })[]; open: Record<string, number>; blocklist: string[] };

/** Re-runs `load` on every browser.* event. */
function useBrowserEvents(load: () => void) {
  useEffect(() => {
    load();
    const un = listen<{ kind: string }>("mr-event", (e) => { if (e.payload.kind.startsWith("browser.")) load(); });
    return () => { void un.then((f) => f()); };
  }, [load]);
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Focus header: linked-tab chips, the open batch, Review & send. Hidden until something is linked. */
export function BrowserChips({ session }: { session: string }) {
  const [st, setSt] = useState<SessionBrowser | null>(null);
  const [review, setReview] = useState(false);
  const [servers, setServers] = useState<string[]>([]);
  const [extension, setExtension] = useState(false);
  const [asking, setAsking] = useState(false);
  const [err, setErr] = useState("");
  const load = useCallback(() => { invoke<SessionBrowser>("browser_session", { session }).then(setSt, () => setSt(null)); }, [session]);
  useBrowserEvents(load);
  useEffect(() => {
    // ⌥⇧A in Chrome suggests the session you're looking at when no session serves the page.
    void invoke("browser_focused", { session }).catch(() => {});
    invoke<string[]>("browser_servers", { session }).then(setServers, () => {});
    invoke<Status>("browser_status").then((x) => setExtension(x.connected > 0), () => {});
  }, [session]);
  if (!st) return null;
  // Your own Chrome when the extension is there (localhost tabs link themselves); else Cockpit's
  // own Chrome window, which needs no setup and opens the page already linked.
  const inCockpit = (url: string) => { setErr(""); invoke("browser_launch_open", { session, url }).then(() => setAsking(false), (e) => setErr(shortError(e))); };
  const open = (url: string) => (extension ? void openUrl(url).catch(() => {}) : inCockpit(url));
  return (
    <>
      {st.links.map((l) => (
        <span key={l.tab} data-mr="BrowserChip" data-mr-source={l.tab} className="mr-row" style={{ gap: 4, padding: "2px 6px", background: "var(--mr-well)", borderRadius: 2, maxWidth: 220 }} title={l.url}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.title || l.url}</span>
          <button type="button" className="mr-dim" aria-label="Unlink tab" style={{ border: 0, background: "transparent", cursor: "pointer" }} onClick={() => void invoke("browser_unlink", { tab: l.tab })}>×</button>
        </span>
      ))}
      {!st.links.length && servers.slice(0, 1).map((u) => <Key key={u} onClick={() => open(u)}>Annotate {u.replace(/^https?:\/\//, "").replace(/\/$/, "")}</Key>)}
      {asking
        ? <form className="mr-row" style={{ gap: 4 }} data-mr="BrowserOpen" data-mr-source={session} onSubmit={(e) => { e.preventDefault(); const v = new FormData(e.currentTarget).get("url"); if (v) inCockpit(String(v)); }}>
            <input name="url" autoFocus defaultValue={servers[0] ?? ""} placeholder="https://staging.example.com" aria-label="Page to annotate" style={{ width: 240 }} onKeyDown={(e) => { if (e.key === "Escape") setAsking(false); }} />
            <Key submit tone="primary">Open</Key>
          </form>
        : <Key onClick={() => setAsking(true)}>Annotate a page…</Key>}
      {err && <span style={{ color: "var(--mr-error)" }}>{err}</span>}
      {st.pins > 0 && <Key tone="primary" onClick={() => setReview(true)}>Review & send {plural(st.pins, "pin")}</Key>}
      {!st.pins && st.carryable > 0 && <Key onClick={() => void invoke("browser_carry", { session })}>Carry {st.carryable} open {st.carryable === 1 ? "pin" : "pins"}</Key>}
      {review && <ReviewSheet session={session} onClose={() => setReview(false)} />}
    </>
  );
}

/** The batch review in Cockpit: the same data and the same confirm as the sheet on the page. */
export function ReviewSheet({ session, onClose }: { session: string; onClose: () => void }) {
  const [b, setB] = useState<Review | null>(null);
  const [order, setOrder] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState("");
  const load = useCallback(() => {
    invoke<Review>("browser_batch", { session }).then((r) => {
      setB(r);
      setOrder(r.tabs.flatMap((t) => t.pages.flatMap((p) => p.pins.map((x) => x.id))));
      setNote((n) => n || r.note);
    }, (e) => setMsg(shortError(e)));
  }, [session]);
  useEffect(load, [load]);
  if (!b) return null;
  const pins = Object.fromEntries(b.tabs.flatMap((t) => t.pages.flatMap((p) => p.pins.map((x) => [x.id, { ...x, tab: t.title }]))));
  const ids = order.filter((id) => pins[id]);
  const move = (i: number, d: number) => { const j = i + d; if (j < 0 || j >= ids.length) return; const o = ids.slice(); [o[i], o[j]] = [o[j], o[i]]; setOrder(o); };
  const confirm = async () => {
    const r = await invoke<{ error?: string; message?: string }>("browser_confirm", { session, note, order: ids }).catch((e) => ({ error: shortError(e), message: undefined }));
    if (r.error) return setMsg(r.message || r.error);
    onClose();
  };
  return (
    <div role="dialog" aria-label="Review browser pins" className="mr-scrim" style={{ position: "fixed", inset: 0, display: "flex", justifyContent: "center", alignItems: "flex-start", padding: "56px 24px", background: "rgba(21,24,27,.35)", zIndex: 30, overflowY: "auto" }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div data-mr="BrowserReview" data-mr-source={session} className="mr-sheet" style={{ width: "100%", maxWidth: 820, background: "var(--mr-tile)" }}>
        <div className="mr-row mr-band" style={{ padding: "12px 16px" }}><strong>Send {plural(ids.length, "pin")} from {plural(b.tab_count, "tab")} to {b.title}</strong><span className="mr-grow" /><Key k="esc" onClick={onClose}>Cancel</Key></div>
        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 6 }}>
          {ids.map((id, i) => {
            const p = pins[id];
            return (
              <div key={id} data-mr="BrowserPin" data-mr-source={id} style={{ display: "grid", gridTemplateColumns: "24px 120px 1fr auto", gap: 8, padding: 8, background: "var(--mr-base)", borderRadius: 2 }}>
                <b>{i + 1}.</b>
                {p.thumb ? <img src={p.thumb} alt="" style={{ maxWidth: 120, maxHeight: 80 }} /> : <span className="mr-dim" style={{ fontSize: 12 }}>no crop</span>}
                <div style={{ minWidth: 0 }}>
                  <div className="mr-dim" style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.tab} · {p.url}</div>
                  <code style={{ fontSize: 12 }}>{p.kind === "box" ? "[box]" : p.selector}</code>
                  {p.redactions > 0 && <div className="mr-dim" style={{ fontSize: 12 }}>{plural(p.redactions, "field")} redacted</div>}
                  <textarea defaultValue={p.note} aria-label={`Note for pin ${i + 1}`} style={{ width: "100%", marginTop: 4 }}
                    onBlur={(e) => { if (e.target.value !== p.note) void invoke("browser_pin_edit", { session, pin: id, note: e.target.value }); }} />
                </div>
                <div className="mr-row" style={{ gap: 4, alignItems: "flex-start" }}>
                  <Key onClick={() => move(i, -1)}>↑</Key><Key onClick={() => move(i, 1)}>↓</Key>
                  <Key onClick={() => void invoke("browser_pin_edit", { session, pin: id, remove: true }).then(load)}>Remove</Key>
                </div>
              </div>
            );
          })}
          <textarea placeholder="A note for the whole batch (optional)" value={note} onChange={(e) => setNote(e.target.value)} style={{ width: "100%" }} />
          <div className="mr-row" style={{ gap: 8 }}>
            <Key tone="primary" disabled={!ids.length} onClick={() => void confirm()}>Confirm & send {plural(ids.length, "pin")}</Key>
            <span className="mr-dim" style={{ fontSize: 12 }}>Nothing is sent until you confirm. Page content goes to {b.title} marked as untrusted.</span>
            {msg && <span style={{ color: "var(--mr-error)" }}>{msg}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Settings → Browser: set up, live links, Disconnect all, the block list. */
export function BrowserSettings() {
  const [st, setSt] = useState<Status | null>(null);
  const [msg, setMsg] = useState("");
  const [block, setBlock] = useState<string | null>(null);
  const load = useCallback(() => { invoke<Status>("browser_status").then(setSt, (e) => setMsg(shortError(e))); }, []);
  useBrowserEvents(load);
  const setup = async () => {
    try {
      const r = await invoke<{ browsers: string[]; extension_dir: string }>("browser_setup");
      setMsg(r.browsers.length ? `Host installed for ${r.browsers.join(", ")}. In chrome://extensions: turn on Developer mode, click Load unpacked, pick the folder that opened.` : "No Chromium browser found (Chrome, Brave, Edge, Chromium, Arc).");
      load();
    } catch (e) { setMsg(shortError(e)); }
  };
  if (!st) return msg ? <p style={{ color: "var(--mr-error)" }}>{msg}</p> : null;
  return (
    <section data-mr="BrowserSettings" style={{ padding: "0 16px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
      <h2 className="mr-h">Browser <span className="mr-dim" style={{ fontWeight: 400 }}>pin problems on any page in Chrome; nothing is sent until you confirm</span></h2>
      <span className="mr-dim" style={{ fontSize: 12 }}>
        No setup needed: <b>Annotate a page…</b> in a session opens Cockpit's own Chrome window (its own profile; log in to sites there once). {st.launched ? "It's open now." : ""}
        {" "}To annotate in your own Chrome profile instead, set up the extension below.
      </span>
      <div className="mr-row" style={{ gap: 12, flexWrap: "wrap" }}>
        <Key tone={st.installed ? undefined : "primary"} onClick={() => void setup()}>{st.installed ? "Set up again" : "Set up browser"}</Key>
        <span className="mr-dim" style={{ fontSize: 12 }}>
          {st.connected ? `Extension connected (${st.connected}).` : st.installed ? "Not connected: load the extension in Chrome, or open Chrome." : "About 30 s per Chrome profile: Cockpit writes the extension and its host, you click Load unpacked once."}
          {" "}Then ⌥⇧A on a page links it to a session; ⌥A annotates.
        </span>
      </div>
      {msg && <span className="mr-dim" style={{ fontSize: 12 }}>{msg}</span>}
      {st.installed && <code className="mr-dim" style={{ fontSize: 12 }}>{st.extension_dir}</code>}
      <h3 className="mr-h" style={{ fontSize: 13 }}>Linked tabs</h3>
      {!st.links.length && <span className="mr-dim" style={{ fontSize: 12 }}>None. Links drop after 30 minutes idle and when a tab closes.</span>}
      {st.links.map((l) => (
        <div key={l.tab} className="mr-row" style={{ gap: 8 }} data-mr="BrowserLink" data-mr-source={l.tab}>
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.title || l.url} <span className="mr-dim">→ {l.session_title || l.session}</span></span>
          <Key onClick={() => void invoke("browser_unlink", { tab: l.tab })}>Unlink</Key>
        </div>
      ))}
      {st.links.length > 0 && <div><Key onClick={() => void invoke("browser_disconnect_all")}>Disconnect all</Key></div>}
      <h3 className="mr-h" style={{ fontSize: 13 }}>Blocked sites <span className="mr-dim" style={{ fontWeight: 400 }}>one per line; * matches anything; the overlay never loads there</span></h3>
      <textarea rows={5} value={block ?? st.blocklist.join("\n")} onChange={(e) => setBlock(e.target.value)} style={{ width: "100%", fontFamily: "var(--mr-mono, monospace)" }} />
      {block !== null && <div><Key tone="primary" onClick={() => void invoke("browser_blocklist_set", { blocklist: block.split("\n").map((x) => x.trim()).filter(Boolean) }).then(() => { setBlock(null); load(); })}>Save block list</Key></div>}
    </section>
  );
}
