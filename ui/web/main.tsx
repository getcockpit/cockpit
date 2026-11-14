import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/atkinson-hyperlegible-next/400.css";
import "@fontsource/atkinson-hyperlegible-next/700.css";
import "@fontsource/atkinson-hyperlegible-mono/400.css";
import "../src/design/tokens.css";
import "../src/design/components.css";
import "../src/mobile/mobile.css";
import { MobileApp } from "../src/mobile/MobileApp";
import { install } from "./webcore";

// Cockpit Remote's installable web app (decisions 46, 47): the phone UI on the web core, which
// talks to your Mac over the wasm link. Built by scripts/build-remote-web.sh into site/remote/.
install();
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <MobileApp />
  </React.StrictMode>,
);
