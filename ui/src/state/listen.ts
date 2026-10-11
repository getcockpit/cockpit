import { listen as tauriListen, type EventCallback, type UnlistenFn } from "@tauri-apps/api/event";

// Tauri keeps a page's event listeners until they're unlistened. A reload (Vite full reload, the
// self-build restarting the webview) skips React cleanup, so the core kept emitting to dead
// callbacks and logged "Couldn't find callback id" on every event. Drop them all on pagehide.
const live = new Set<UnlistenFn>();
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => { for (const f of [...live]) f(); });
}

export function listen<T>(event: string, cb: EventCallback<T>): Promise<UnlistenFn> {
  return tauriListen<T>(event, cb).then((un) => {
    const f: UnlistenFn = () => { if (live.delete(f)) un(); };
    live.add(f);
    return f;
  });
}
