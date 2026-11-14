import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The iPhone app (mobile/, Cockpit Remote): the same React code and reducer, its own entry and
// layout. `bun run build:mobile` → dist-mobile/, which mobile/src-tauri bundles.
export default defineConfig({
  plugins: [react()],
  root: "mobile",
  build: { outDir: "../dist-mobile", emptyOutDir: true },
  clearScreen: false,
  server: { port: 1422, strictPort: true, host: "0.0.0.0", fs: { allow: [".."] } },
});
