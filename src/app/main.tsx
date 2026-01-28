import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "../global.css";

// Ensure Tauri class is applied (backup check - head script may run before __TAURI__ is available)
if (
  typeof window !== "undefined" &&
  ((window as any).__TAURI__ || (window as any).__TAURI_INTERNALS__)
) {
  document.documentElement.classList.add("tauri");
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
