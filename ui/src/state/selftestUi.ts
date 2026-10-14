import { listen } from "./listen";
import { api } from "./store";

// The UI half of self-tests that need the real screen (MR_SELFTEST, src-tauri/src/selftest.rs).
// `attach` (MR-141): open the session, then do to its message box what you would — paste a
// screenshot (an image file on the clipboard), paste a long text, drop a PDF — and send.
// Each step is logged as ui.selftest_attach, so the script can tell where it stopped.

const step = (session: string, name: string, extra: Record<string, unknown> = {}) =>
  api.log("ui.selftest_attach", { step: name, ...extra }, session).catch(() => {});

async function until<T>(f: () => T | null | undefined | false, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}

function paste(box: HTMLTextAreaElement, dt: DataTransfer) {
  box.focus();
  const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
  if (!ev.clipboardData) Object.defineProperty(ev, "clipboardData", { value: dt });
  box.dispatchEvent(ev);
}

// A 64×64 red PNG, made the way a screenshot arrives: a File called image.png.
async function redPng(): Promise<File> {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  g.fillStyle = "#ff0000";
  g.fillRect(0, 0, 64, 64);
  const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), "image/png"));
  return new File([blob], "image.png", { type: "image/png" });
}

async function attach(session: string, pdf: string, open: (id: string) => void) {
  // Open it the way a click on its tile does; again if the screen hadn't settled yet.
  let tries = 0;
  const box = await until(() => {
    const b = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message this session"]');
    if (!b && tries++ % 10 === 0) open(session);
    return b;
  });
  await step(session, "box");
  const img = new DataTransfer();
  img.items.add(await redPng());
  paste(box, img);
  await until(() => document.querySelectorAll('[data-mr="AttachmentChip"]').length >= 1);
  await step(session, "image", { thumbnail: !!document.querySelector('[data-mr="AttachmentChip"] img') });
  // The drop path: state/fileDrop.ts hands a box the dropped paths as this event.
  box.dispatchEvent(new CustomEvent("mr:files", { detail: [pdf], cancelable: true }));
  await until(() => document.querySelectorAll('[data-mr="AttachmentChip"]').length >= 2);
  await step(session, "pdf");
  const long = new DataTransfer();
  long.setData("text/plain", Array.from({ length: 20 }, (_, i) => `filler line ${i + 1}`).join("\n"));
  paste(box, long);
  await until(() => document.querySelector('[data-mr="PasteChip"]'));
  await step(session, "folded", { token: box.value.includes("[Pasted text #") });
  // Type the question the way a keystroke does, after the token.
  const ask = `${box.value} Ignore the filler lines. What colour fills the attached image, and what word does the attached PDF say? Answer on one line as: <colour> <word>. Then on a new line reply with exactly: SELFTEST DONE`;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, ask);
  box.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 200));
  const send = await until(() => [...document.querySelectorAll<HTMLButtonElement>("form button")].find((b) => b.textContent?.includes("Send")));
  send.click();
  await until(() => !document.querySelector('[data-mr="PromptBox"] [data-mr="AttachmentChip"]'));
  await step(session, "sent");
}

/** Listens for the core's go-ahead; returns the unlisten. */
export function listenSelftest(open: (id: string) => void): () => void {
  let stop = () => {};
  let gone = false;
  listen<{ mode: string; session: string; pdf: string }>("mr:selftest", ({ payload: p }) => {
    if (p.mode === "attach") attach(p.session, p.pdf, open).catch((e) => void step(p.session, "failed", { error: String(e), screen: [...new Set([...document.querySelectorAll("[data-mr]")].map((x) => x.getAttribute("data-mr")))].slice(0, 30), boxes: [...document.querySelectorAll("textarea")].map((x) => x.getAttribute("aria-label")), text: document.body.innerText.slice(0, 300) }));
  }).then((u) => (gone ? u() : (stop = u))).catch(() => {});
  return () => { gone = true; stop(); };
}
