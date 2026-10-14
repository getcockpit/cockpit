import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { installCommand, NoClaude } from "./NoClaude";
import { replay } from "../state/reduce";
import type { MrEvent } from "../state/types";

const ev = (id: string, kind: string, payload: Record<string, unknown>): MrEvent => ({ id, session_id: null, kind, payload, anchor: null, created_at: 1_000 });

test("the install command fits the OS", () => {
  expect(installCommand("Mozilla/5.0 (X11; Linux x86_64)")).toBe("curl -fsSL https://claude.ai/install.sh | bash");
  expect(installCommand("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("irm https://claude.ai/install.ps1 | iex");
});

test("a sidecar without claude, then a re-check that finds it", () => {
  const missing = replay([ev("A1", "sidecar.ready", { claude: null })]);
  expect(missing.sidecar).toEqual({ up: true, claude: null });
  const found = replay([ev("A2", "sidecar.claude", { claude: "/home/u/.local/bin/claude" })], missing);
  expect(found.sidecar).toEqual({ up: true, claude: "/home/u/.local/bin/claude" });
});

test("the banner says how to install and offers a re-check", () => {
  const html = renderToStaticMarkup(<NoClaude />);
  expect(html).toContain('data-mr="NoClaude"');
  expect(html).toContain("isn&#x27;t installed");
  expect(html).toContain("Check again");
});
