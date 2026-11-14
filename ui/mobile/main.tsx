import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/atkinson-hyperlegible-next/400.css";
import "@fontsource/atkinson-hyperlegible-next/700.css";
import "@fontsource/atkinson-hyperlegible-mono/400.css";
import "../src/design/tokens.css";
import "../src/design/components.css";
import "../src/mobile/mobile.css";
import { MobileApp } from "../src/mobile/MobileApp";

// Cockpit Remote's iPhone entry (mobile/src-tauri). In a plain browser it runs on the demo core
// (?demo=busy, ?remote=unpaired) so the screens can be walked without a phone or a Mac.
// Two cores: the native iOS app's (Tauri), or the demo core for walking the screens in a browser.
// The installable web app has its own entry (ui/web) with the wasm link.
const native = "__TAURI_INTERNALS__" in window;
const core =
  !native && import.meta.env.VITE_MR_PACKAGED !== "1"
    ? import("../src/demo/backend").then((m) => m.install(new URLSearchParams(location.search).get("demo") ?? "busy"))
    : Promise.resolve();
core.then(() =>
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <MobileApp />
    </React.StrictMode>,
  ),
);
