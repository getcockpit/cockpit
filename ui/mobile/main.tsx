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
const demo = import.meta.env.VITE_MR_PACKAGED !== "1" && !("__TAURI_INTERNALS__" in window) ? new URLSearchParams(location.search).get("demo") ?? "busy" : null;
(demo ? import("../src/demo/backend").then((m) => m.install(demo)) : Promise.resolve()).then(() =>
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <MobileApp />
    </React.StrictMode>,
  ),
);
