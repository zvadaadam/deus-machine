import { useEffect } from "react";
import { isElectronEnv } from "@/platform/electron";

/**
 * Interactive element selector -- clicks on these pass through instead of
 * triggering a window drag. Matches buttons, links, inputs, and ARIA roles.
 */
const INTERACTIVE_SELECTOR =
  'button, a, input, select, textarea, [role="button"], [role="link"], [role="tab"], [data-slot="sidebar-menu-button"], [data-slot="sidebar-menu-action"]';

/**
 * Window-level drag zone for Electron.
 *
 * In Electron, we use `-webkit-app-region: drag` CSS to enable window dragging.
 * However, since the drag region is applied via CSS, we need to mark interactive
 * elements as `no-drag` to allow clicks through. This hook adds a mousedown
 * listener that applies the CSS dynamically within the specified top height.
 *
 * In Electron, we use `-webkit-app-region: drag` CSS. This is simpler than
 * other approaches since it's handled at the compositor level.
 */
export function useWindowDragZone(height: number = 48) {
  useEffect(() => {
    if (!isElectronEnv) return;

    // Apply drag region CSS to the document for the top area
    const style = document.createElement("style");
    style.textContent = `
      /* Electron window drag region -- top ${height}px of the viewport */
      [data-electron-drag-region] {
        -webkit-app-region: drag;
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        height: ${height}px;
        z-index: 99999;
        pointer-events: auto;
      }
      /* Exclude interactive elements from drag */
      [data-electron-drag-region] ${INTERACTIVE_SELECTOR} {
        -webkit-app-region: no-drag;
      }
    `;
    document.head.appendChild(style);

    // Create the drag region overlay element
    const dragRegion = document.createElement("div");
    dragRegion.setAttribute("data-electron-drag-region", "true");
    document.body.appendChild(dragRegion);

    // Allow clicks to pass through to interactive elements underneath
    const handleMouseDown = (e: MouseEvent) => {
      const target = document.elementFromPoint(e.clientX, e.clientY);
      if (
        target &&
        target !== dragRegion &&
        (target as HTMLElement).closest(INTERACTIVE_SELECTOR)
      ) {
        // Re-dispatch the click to the actual target
        dragRegion.style.pointerEvents = "none";
        requestAnimationFrame(() => {
          dragRegion.style.pointerEvents = "auto";
        });
      }
    };

    dragRegion.addEventListener("mousedown", handleMouseDown);

    return () => {
      dragRegion.removeEventListener("mousedown", handleMouseDown);
      dragRegion.remove();
      style.remove();
    };
  }, [height]);
}
