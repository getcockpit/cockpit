import { getCurrentWebview } from "@tauri-apps/api/webview";
import { insertDropped } from "../picker/mention";

// Files thrown into the app: dropped on a message box they land as @ mentions at the caret, so
// Claude reads them (images too). Off a box, they go to the box in focus, else this session's.
// A box that handles files itself (PromptBox: images attach with a thumbnail) takes the
// `mr:files` event and cancels it.
const BOX = "input.mr-input, textarea.mr-input";

function boxAt(x: number, y: number): HTMLInputElement | HTMLTextAreaElement | null {
  const under = document.elementFromPoint(x, y)?.closest?.(BOX);
  const box = under ?? document.activeElement?.closest?.(BOX) ?? document.querySelector('[aria-label="Message this session"]');
  return box instanceof HTMLInputElement || box instanceof HTMLTextAreaElement ? box : null;
}

// Set the value the way typing does, so React's onChange sees it.
function put(box: HTMLInputElement | HTMLTextAreaElement, paths: string[]) {
  const start = box.selectionStart ?? box.value.length, end = box.selectionEnd ?? start;
  const next = insertDropped(box.value, start, end, paths);
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box), "value")!.set!.call(box, next.text);
  box.dispatchEvent(new Event("input", { bubbles: true }));
  box.focus();
  box.setSelectionRange(next.caret, next.caret);
}

let hovered: Element | null = null;
const mark = (el: Element | null) => {
  if (el === hovered) return;
  hovered?.removeAttribute("data-mr-drop");
  el?.setAttribute("data-mr-drop", "");
  hovered = el;
};

/** Listens for files dragged over the window; returns the unlisten. Desktop app only. */
export function listenFileDrop(): () => void {
  let stop = () => {};
  let gone = false;
  let webview;
  try { webview = getCurrentWebview(); } catch { return stop; } // the demo harness has no webview
  webview.onDragDropEvent(({ payload: p }) => {
    // Positions come in physical pixels.
    const at = (q: { x: number; y: number }) => boxAt(q.x / devicePixelRatio, q.y / devicePixelRatio);
    if (p.type === "over") mark(at(p.position));
    else if (p.type === "leave") mark(null);
    else if (p.type === "drop") {
      mark(null);
      if (!p.paths.length) return;
      const box = at(p.position);
      if (box && box.dispatchEvent(new CustomEvent("mr:files", { detail: p.paths, cancelable: true }))) put(box, p.paths);
      else window.dispatchEvent(new CustomEvent("mr:toast", { detail: "Drop files on a message box to send them to Claude" }));
    }
  }).then((u) => (gone ? u() : (stop = u))).catch(() => {});
  return () => { gone = true; stop(); };
}
