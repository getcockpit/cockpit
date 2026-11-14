// Spike service worker (decision 46): shows each push and tells open pages what arrived.
self.addEventListener("push", (e) => {
  const text = e.data ? e.data.text() : "";
  e.waitUntil((async () => {
    for (const c of await self.clients.matchAll({ includeUncontrolled: true })) c.postMessage({ push: text });
    await self.registration.showNotification("Cockpit", { body: text });
  })());
});
