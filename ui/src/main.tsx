import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/atkinson-hyperlegible-next/400.css";
import "@fontsource/atkinson-hyperlegible-next/600.css";
import "@fontsource/atkinson-hyperlegible-next/700.css";
import "@fontsource/atkinson-hyperlegible-mono/400.css";
import "@fontsource/atkinson-hyperlegible-mono/700.css";
import "./design/tokens.css";
import "./design/components.css";
import "./design/motion.css";
import App from "./App";

// Outside the desktop app (a plain browser), run against the scripted demo core: ?demo=busy etc.
const demo = !("__TAURI_INTERNALS__" in window) ? new URLSearchParams(location.search).get("demo") ?? "busy" : null;
(demo ? import("./demo/backend").then((m) => m.install(demo)) : Promise.resolve()).then(() =>
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  ),
);
