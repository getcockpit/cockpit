import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "../state/listen";
import { shortError } from "./ErrorLine";
import { Key } from "./index";

// Settings → Remote (doc "Cockpit Remote"): turn the phone link on, pair one iPhone by QR in
// person, confirm the 6-digit code, see when it was last here, unpair. The link itself is
// src-tauri/src/remote.rs; nothing here ever leaves the Mac except over the pinned link.

type Status = {
  enabled: boolean;
  running: boolean;
  mac_id: string | null;
  phone: { key: string; name: string; paired_at: number; passkey?: unknown } | null;
  pending: { code: string; name: string } | null;
  connected: boolean;
  last_seen: number | null;
  awake?: boolean;
};
type Qr = { text: string; svg: string; expires_at: number };

const ago = (t: number) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(t).toLocaleDateString();
};

export function RemoteSettings() {
  const [st, setSt] = useState<Status | null>(null);
  const [qr, setQr] = useState<Qr | null>(null);
  const [msg, setMsg] = useState("");
  const [now, setNow] = useState(Date.now());
  const load = useCallback(() => { invoke<Status>("remote_status").then(setSt, (e) => setMsg(shortError(e))); }, []);
  useEffect(() => {
    load();
    const un = listen("mr-remote", () => load());
    const t = setInterval(() => { setNow(Date.now()); load(); }, 2000);
    return () => { un.then((f) => f()); clearInterval(t); };
  }, [load]);
  // A QR is spent once a phone uses it, and it expires after 2 min.
  useEffect(() => { if (qr && (st?.pending || now > qr.expires_at)) setQr(null); }, [st?.pending, now, qr]);

  const act = async (f: () => Promise<unknown>, done = "") => { setMsg(""); try { await f(); setMsg(done); load(); } catch (e) { setMsg(shortError(e)); } };
  if (!st) return msg ? <p style={{ color: "var(--mr-error)" }}>{msg}</p> : null;
  const secsLeft = qr ? Math.max(0, Math.round((qr.expires_at - now) / 1000)) : 0;

  return (
    <section data-mr="RemoteSettings" style={{ padding: "0 16px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
      <h2 className="mr-h">Remote <span className="mr-dim" style={{ fontWeight: 400 }}>your iPhone, straight to this Mac: end-to-end encrypted, no server of ours</span></h2>
      <div className="mr-row" style={{ gap: 12, flexWrap: "wrap" }}>
        <Key tone={st.enabled ? undefined : "primary"} onClick={() => void act(() => invoke("remote_set_enabled", { on: !st.enabled }))}>{st.enabled ? "Turn Remote off" : "Turn Remote on"}</Key>
        <span className="mr-dim" style={{ fontSize: 12 }}>
          {st.enabled
            ? st.running ? `On. Only the paired phone can connect; off cuts it at once. ${st.awake ? "Keeping this Mac awake while sessions work." : "The Mac may sleep while nothing works."} A closed lid on battery still sleeps.` : "On, but the link didn't start. Turn it off and on again."
            : "Off: no link, nothing reachable. The phone app pairs once, in person, by QR."}
        </span>
      </div>

      {st.running && st.pending && (
        <div data-mr="RemotePairConfirm" className="mr-row" style={{ gap: 12, padding: 10, background: "var(--mr-well)", borderLeft: "3px solid var(--mr-needs)", flexWrap: "wrap" }}>
          <span><b>{st.pending.name || "A phone"}</b> wants to pair. Does it show <b style={{ fontFamily: "var(--mr-mono)", fontSize: 18, letterSpacing: 2 }}>{st.pending.code}</b>?</span>
          <span className="mr-grow" />
          <Key tone="needs" onClick={() => void act(() => invoke("remote_pair_answer", { accept: true }), "Paired.")}>Same code: pair</Key>
          <Key onClick={() => void act(() => invoke("remote_pair_answer", { accept: false }), "Declined.")}>Different: decline</Key>
        </div>
      )}

      {st.running && (
        <div className="mr-row" style={{ gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
          {st.phone ? (
            <span style={{ fontSize: 13 }}>
              Paired with <b>{st.phone.name}</b> ({st.phone.key.slice(0, 10)}…) since {new Date(st.phone.paired_at).toLocaleDateString()}.{" "}
              <span className="mr-dim">{st.connected ? "Connected now." : st.last_seen ? `Last here ${ago(st.last_seen)}.` : "Not connected yet."}</span>
              {st.phone.passkey ? <span className="mr-dim"> Face ID guards every allow, answer and start (checked here).</span> : null}
            </span>
          ) : <span className="mr-dim" style={{ fontSize: 13 }}>No phone paired.</span>}
          <span className="mr-grow" />
          {!qr && <Key onClick={() => void act(async () => setQr(await invoke<Qr>("remote_pair_start")))}>{st.phone ? "Pair a new phone (replaces it)" : "Pair a phone"}</Key>}
          {st.phone && <Key onClick={() => void act(() => invoke("remote_unpair"), "Unpaired. The phone is cut off and this Mac has a new key.")}>Unpair</Key>}
        </div>
      )}

      {qr && (
        <div data-mr="RemotePairQr" className="mr-row" style={{ gap: 16, alignItems: "flex-start" }}>
          <div style={{ background: "var(--mr-qr-bg)", padding: 4, lineHeight: 0 }} dangerouslySetInnerHTML={{ __html: qr.svg }} />
          <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
            <span>Scan this with your iPhone's camera. It opens Cockpit Remote; the code works once, for {secsLeft} s more.</span>
            <span className="mr-dim" style={{ fontSize: 12 }}>Both screens then show the same 6-digit code; confirm it here. Keep this code private: it's the key to pairing.</span>
            <div className="mr-row" style={{ gap: 8 }}>
              <Key onClick={() => void navigator.clipboard.writeText(qr.text).then(() => setMsg("Copied. On an iPhone signed in to the same Apple Account, tap Paste from Mac in Cockpit Remote."))}>Copy as text</Key>
              <Key onClick={() => setQr(null)}>Cancel</Key>
            </div>
          </div>
        </div>
      )}
      {msg && <span className="mr-dim" style={{ fontSize: 12 }}>{msg}</span>}
    </section>
  );
}
