import { readFileSync, statSync } from "node:fs";
import type { Attachment } from "./protocol";

// A message's attachments as the content Claude Code takes: images and PDFs as base64 blocks, so
// Claude sees them at once; every file also listed by path, so it can open, crop or re-read it.
// Without attachments the content stays a plain string, as before.

const IMAGE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGE = 3_700_000; // 5 MB once base64-encoded, the API's cap per image
const MAX_PDF = 20_000_000;

export function userContent(text: string, attachments?: Attachment[]): string | Record<string, unknown>[] {
  if (!attachments?.length) return text;
  const blocks: Record<string, unknown>[] = [];
  const lines: string[] = [];
  for (const a of attachments) {
    const size = sizeOf(a.path);
    if (size === null) { lines.push(`- ${a.path} (missing: it was moved or deleted)`); continue; }
    const mime = IMAGE.has(a.mime) || a.mime === "application/pdf" ? a.mime : mimeOf(a.path);
    try {
      if (IMAGE.has(mime) && size <= MAX_IMAGE) {
        blocks.push({ type: "image", source: { type: "base64", media_type: mime, data: readFileSync(a.path).toString("base64") } });
        lines.push(`- ${a.path} (image, shown above)`);
        continue;
      }
      if (mime === "application/pdf" && size <= MAX_PDF) {
        blocks.push({ type: "document", source: { type: "base64", media_type: mime, data: readFileSync(a.path).toString("base64") }, title: a.name });
        lines.push(`- ${a.path} (PDF, shown above)`);
        continue;
      }
    } catch { /* unreadable: fall back to the path */ }
    lines.push(`- ${a.path}${IMAGE.has(mime) ? " (image too large to inline; read it)" : ""}`);
  }
  const note = `\n\nAttached files:\n${lines.join("\n")}`;
  return [...blocks, { type: "text", text: (text || "See the attached files.") + note }];
}

function sizeOf(path: string): number | null {
  try { return statSync(path).size; } catch { return null; }
}

export function mimeOf(path: string): string {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  return ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf" } as Record<string, string>)[ext] ?? "application/octet-stream";
}
