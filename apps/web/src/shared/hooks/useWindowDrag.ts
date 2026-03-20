import { useEffect } from "react";
import { isElectronEnv } from "@/platform/electron/invoke";

/**
 * Electron window drag zone — CSS-only approach.
 *
 * Adds the `.electron` class to `<html>` when running inside Electron.
 * Components use this to conditionally apply drag regions via CSS:
 *
 *   <div className="drag-region ...">  ← draggable in Electron, normal in browser
 *     <button>Click me</button>        ← auto no-drag via CSS descendant rule
 *   </div>
 *
 * The CSS rules are injected into <head> so they work with any component.
 * Interactive elements (buttons, inputs, links, tabs) are automatically
 * excluded from drag via `-webkit-app-region: no-drag`.
 *
 * NO overlay div. NO z-index hacks. NO pointer-events manipulation.
 * This is how OpenDevs, Cursor, and other Electron apps handle it.
 */
export function useWindowDragZone() {
  useEffect(() => {
    if (!isElectronEnv) return;

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
