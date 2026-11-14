// Cockpit Remote spike (decision 46): shows the pushes your Mac sends. Each push is encrypted to
// this phone; the browser decrypts it before this runs. Tapping a notification opens the app.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("push", (e) => {
  let p = { title: "Cockpit", body: e.data ? e.data.text() : "" };
  try { p = e.data.json(); } catch { /* plain text */ }
  e.waitUntil(self.registration.showNotification(p.title || "Cockpit", { body: p.body || "", tag: p.tag || undefined, icon: "icon-192.png", data: p }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (all[0]) return all[0].focus();
    return self.clients.openWindow("./");
  })());
});
