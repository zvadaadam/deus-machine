import { useEffect } from "react";
import { capabilities } from "@/platform/capabilities";

/**
 * Adds `.electron` class to `<html>` and injects CSS-only drag region rules.
 * Components opt in with `className="drag-region"`. Interactive descendants
 * (buttons, inputs, links, tabs) are automatically excluded.
 */
export function useWindowDragZone() {
  useEffect(() => {
    if (!capabilities.nativeWindowChrome) return;

    document.documentElement.classList.add("electron");

    // Inject CSS rules for drag regions
    const style = document.createElement("style");
    style.setAttribute("data-electron-drag", "true");
    style.textContent = `
      /* Elements with .drag-region class become draggable in Electron */
      .electron .drag-region {
        -webkit-app-region: drag;
      }

      /* All interactive elements inside drag regions are excluded */
      .electron .drag-region button,
      .electron .drag-region a,
      .electron .drag-region input,
      .electron .drag-region select,
      .electron .drag-region textarea,
      .electron .drag-region [role="button"],
      .electron .drag-region [role="link"],
      .electron .drag-region [role="tab"],
      .electron .drag-region [data-slot="sidebar-menu-button"],
      .electron .drag-region [data-slot="sidebar-menu-action"] {
        -webkit-app-region: no-drag;
      }

      /* Fullscreen: disable drag regions (macOS hides traffic lights) */
      .electron.fullscreen .drag-region {
        -webkit-app-region: no-drag;
      }

      /* Traffic light clearance: push sidebar header below macOS stoplight buttons */
      .electron:not(.fullscreen) [data-slot="sidebar-header"] {
        padding-top: 42px;
      }

      /* Traffic light clearance when sidebar collapsed: push workspace header right */
      .electron:not(.fullscreen)
        [data-slot="sidebar"][data-state="collapsed"][data-variant="inset"]
        ~ [data-slot="sidebar-inset"]
        [data-slot="workspace-header"] {
        padding-inline-start: var(--traffic-light-clearance, 78px);
      }
    `;
    document.head.appendChild(style);

    return () => {
      document.documentElement.classList.remove("electron");
      style.remove();
    };
  }, []);
}
