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
// Three cores: the native iOS app's (Tauri), the web app's (VITE_MR_WEB=1: the wasm link to your
// Mac, decision 46), or the demo core for walking the screens in a browser.
// The web build decides at compile time, so its bundle carries neither the demo core (its fixtures
// come from real sessions, MR-93) nor the choice.
const native = "__TAURI_INTERNALS__" in window;
const core =
  import.meta.env.VITE_MR_WEB === "1"
    ? import("../src/mobile/webcore").then((m) => m.install())
    : !native && import.meta.env.VITE_MR_PACKAGED !== "1"
      ? import("../src/demo/backend").then((m) => m.install(new URLSearchParams(location.search).get("demo") ?? "busy"))
      : Promise.resolve();
core.then(() =>
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <MobileApp />
    </React.StrictMode>,
  ),
);
