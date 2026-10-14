import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// scripts/release-manifest.sh (MR-136): latest.json for the in-app updater, from a release's .sig files.
const FILES = ["Cockpit-macos.app.tar.gz", "Cockpit-linux-x86_64.AppImage", "Cockpit-windows-x64-setup.exe"];
const run = (skip?: string) => {
  const dir = mkdtempSync(join(tmpdir(), "mr-manifest-"));
  for (const f of FILES) if (f !== skip) writeFileSync(join(dir, `${f}.sig`), `SIG-${f}\n`);
  const p = Bun.spawnSync(["bash", join(import.meta.dir, "release-manifest.sh"), "v0.2.0", dir, "- Faster"]);
  rmSync(dir, { recursive: true });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
};

test("latest.json points every platform at its signed bundle", () => {
  const { code, out } = run();
  expect(code).toBe(0);
  const m = JSON.parse(out);
  expect(m.version).toBe("0.2.0");
  expect(m.notes).toBe("- Faster");
  expect(Object.keys(m.platforms).sort()).toEqual(["darwin-aarch64", "darwin-x86_64", "linux-x86_64", "windows-x86_64"]);
  expect(m.platforms["darwin-x86_64"]).toEqual({ signature: "SIG-Cockpit-macos.app.tar.gz", url: "https://github.com/getcockpit/cockpit/releases/download/v0.2.0/Cockpit-macos.app.tar.gz" });
});

test("a missing signature fails the release instead of shipping a partial manifest", () => {
  const { code, out, err } = run("Cockpit-linux-x86_64.AppImage");
  expect(code).not.toBe(0);
  expect(out).toBe("");
  expect(err).toContain("Cockpit-linux-x86_64.AppImage.sig");
});
