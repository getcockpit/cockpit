import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Cockpit Remote's installable web app (decision 46): ui/web on the wasm link. Only
// scripts/build-remote-web.sh builds it (it makes the wasm package first).
export default defineConfig({
  plugins: [react()],
  root: "web",
  publicDir: "../mobile/public",
  // Relative: each version is served from /remote/v/<version>/ and answered at /remote/.
  base: "./",
  build: { outDir: "../dist-web", emptyOutDir: true },
  clearScreen: false,
  server: { port: 1423, strictPort: true, host: "0.0.0.0", fs: { allow: ["../.."] } },
});
