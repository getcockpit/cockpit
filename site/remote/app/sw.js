// Cockpit Remote (decision 46): shows the pushes your Mac sends (encrypted to this phone; the
// browser decrypts them before this runs). Tapping one opens the app on that session.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("push", (e) => {
  let p = { title: "Cockpit", body: e.data ? e.data.text() : "" };
  try { p = e.data.json(); } catch { /* plain text */ }
  e.waitUntil(self.registration.showNotification(p.title || "Cockpit", { body: p.body || "", tag: p.tag || undefined, icon: "icon-192.png", data: { session: p.session || null } }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const session = e.notification.data && e.notification.data.session;
  const url = session ? `./?session=${encodeURIComponent(session)}` : "./";
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (all[0]) { all[0].postMessage({ open: session }); return all[0].focus(); }
    return self.clients.openWindow(url);
  })());
});
