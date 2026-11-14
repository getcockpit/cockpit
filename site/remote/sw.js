// Cockpit Remote's loader (decision 47: pinned updates). Served at /remote/sw.js; changes only
// with this file, never per release. It installs ONE version of the web app, checking every
// file against its SHA-256 and the version's root hash, then serves only that cached copy:
// nothing under /remote/ comes from the network afterwards, so a changed file on the host never
// runs. A new version is fetched only when the page asks, with the root hash your Mac sent over
// the end-to-end encrypted link, and swapped in only if every file checks out.
const BASE = new URL("./", self.location).pathname; // "/remote/"
const META = "cockpit-remote-meta";

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (data) => hex(await crypto.subtle.digest("SHA-256", typeof data === "string" ? new TextEncoder().encode(data) : data));

// The root hash of a version: sha256 of its sorted "<sha256>  <path>\n" lines (as sha256sum prints).
const rootOf = (files) => sha256(files.map(([p, h]) => `${h}  ${p}\n`).join(""));

async function pinned() {
  const r = await (await caches.open(META)).match(BASE + "__pinned");
  return r ? r.json() : null;
}

// Fetches a version into its own cache and checks it all; throws on any mismatch.
async function stage(version, root) {
  const dir = `${BASE}v/${version}/`;
  const list = await (await fetch(dir + "files.json", { cache: "no-store" })).json();
  const files = list.files;
  if ((await rootOf(files)) !== root) throw new Error("the version's file list doesn't match the expected hash");
  const cache = await caches.open(`cockpit-remote-${version}`);
  for (const [path, want] of files) {
    const res = await fetch(dir + path, { cache: "no-store" });
    if (!res.ok) throw new Error(`missing ${path}`);
    const body = await res.clone().arrayBuffer();
    if ((await sha256(body)) !== want) throw new Error(`${path} doesn't match its hash`);
    await cache.put(dir + path, res);
  }
  return { version, root };
}

async function pin(p) {
  const meta = await caches.open(META);
  const old = await pinned();
  await meta.put(BASE + "__pinned", new Response(JSON.stringify({ ...p, previous: old ? old.version : null })));
  // Keep the version before as a fallback; drop older ones.
  for (const name of await caches.keys()) {
    if (name.startsWith("cockpit-remote-") && name !== META && name !== `cockpit-remote-${p.version}` && (!old || name !== `cockpit-remote-${old.version}`)) await caches.delete(name);
  }
}

async function tell(m) {
  for (const c of await self.clients.matchAll({ includeUncontrolled: true })) c.postMessage(m);
}

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    try {
      if (await pinned()) return; // already pinned: a new loader never changes the app on its own
      // First install, trust on first use: the version the site names, checked file by file.
      const cur = await (await fetch(BASE + "current.json", { cache: "no-store" })).json();
      await pin(await stage(cur.version, cur.root));
    } catch (err) {
      await tell({ type: "install-failed", error: String((err && err.message) || err) });
      throw err;
    }
  })());
  self.skipWaiting();
});
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(BASE)) return;
  const rel = url.pathname.slice(BASE.length);
  if (rel === "sw.js" || rel === "current.json" || rel.startsWith("v/")) return; // loader + staging: network
  e.respondWith((async () => {
    const p = await pinned();
    if (!p) return fetch(e.request); // not installed yet: the loader page
    const cache = await caches.open(`cockpit-remote-${p.version}`);
    const hit = (await cache.match(`${BASE}v/${p.version}/${rel || "index.html"}`)) ?? (e.request.mode === "navigate" ? await cache.match(`${BASE}v/${p.version}/index.html`) : undefined);
    if (!hit) return new Response("not part of this version", { status: 404 });
    // A fresh Response keeps the address the page asked for: a cached one carries its /v/<version>/
    // URL, which Safari then uses as the module's base, loading the app's code twice.
    return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers: hit.headers });
  })());
});

self.addEventListener("message", (e) => {
  const reply = (m) => e.source && e.source.postMessage(m);
  if (e.data && e.data.type === "pinned") e.waitUntil(pinned().then((p) => reply({ type: "pinned", pinned: p })));
  if (e.data && e.data.type === "update") {
    const { version, root } = e.data;
    e.waitUntil(stage(version, root).then((p) => pin(p)).then(() => reply({ type: "updated", version }), (err) => reply({ type: "update-failed", error: String(err && err.message || err) })));
  }
});

// Pushes and taps (decision 46): encrypted to this phone; a tap opens its session.
self.addEventListener("push", (e) => {
  let p = { title: "Cockpit", body: e.data ? e.data.text() : "" };
  try { p = e.data.json(); } catch { /* plain text */ }
  e.waitUntil(self.registration.showNotification(p.title || "Cockpit", { body: p.body || "", tag: p.tag || undefined, icon: "icon-192.png", data: { session: p.session || null } }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const session = e.notification.data && e.notification.data.session;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (all[0]) { all[0].postMessage({ open: session }); return all[0].focus(); }
    return self.clients.openWindow(session ? `${BASE}?session=${encodeURIComponent(session)}` : BASE);
  })());
});
