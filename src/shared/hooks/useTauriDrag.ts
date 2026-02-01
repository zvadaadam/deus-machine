import { useEffect } from "react";
import { isTauriEnv } from "@/platform/tauri";

/**
 * Interactive element selector — clicks on these pass through instead of
 * triggering a window drag. Matches buttons, links, inputs, and ARIA roles.
 */
const INTERACTIVE_SELECTOR =
  'button, a, input, select, textarea, [role="button"], [role="link"], [role="tab"], [data-slot="sidebar-menu-button"], [data-slot="sidebar-menu-action"]';

/**
 * Eagerly cache the Tauri window module at import time so that
 * startDragging() can be called SYNCHRONOUSLY inside mousedown.
 *
 * macOS requires the native performWindowDragWithEvent: to fire within the
 * same run-loop pass as the mouseDown event. A dynamic import() — even when
 * the module is already bundled — always resolves as a microtask (one tick
 * later), which misses the OS drag protocol window. Pre-caching avoids this.
 */
let _startDragging: (() => void) | null = null;

if (isTauriEnv) {
  import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
    _startDragging = () => getCurrentWindow().startDragging();
  });
}

/**
 * Window-level drag zone — mirrors Arc browser's transparent overlay approach.
 *
 * Arc uses a separate 44px-tall, full-width, invisible NSPanel sitting on top
 * of the main window to catch mousedown events for dragging. We achieve the
 * same effect with a native `window` mousedown listener that fires for clicks
 * within the top `height` pixels of the viewport.
 *
 * Why global instead of per-element `onMouseDown`:
 *   The main content's context bar sits inside SidebarInset → main-content →
 *   flex wrappers → MainContentTabBar. React's synthetic event must bubble
 *   through all those layers. A native window listener fires first, bypassing
 *   any DOM layering, z-index, overflow:hidden, or stacking context issues.
 *
 * The listener excludes interactive elements (buttons, links, inputs) via the
 * same INTERACTIVE_SELECTOR, so clicks on controls still work normally.
 */
export function useTauriDragZone(height: number = 48) {
  useEffect(() => {
    if (!isTauriEnv) return;

    const handleMouseDown = (e: MouseEvent) => {
      if (!_startDragging || e.button !== 0) return;
      if (e.clientY > height) return;

      const target = e.target as HTMLElement;
      if (target.closest(INTERACTIVE_SELECTOR)) return;

      _startDragging();
    };

    window.addEventListener("mousedown", handleMouseDown);
    return () => window.removeEventListener("mousedown", handleMouseDown);
  }, [height]);
}
