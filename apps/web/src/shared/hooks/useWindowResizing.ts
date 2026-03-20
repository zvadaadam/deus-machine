import { useEffect, useRef } from "react";
import { isElectronEnv } from "@/platform/electron";

/**
 * Detects active window resize and toggles `.window-resizing` class on <html>.
 *
 * CSS transitions fighting native resize animations cause content to appear
 * "stuck" at the old size. This hook disables layout transitions during the
 * resize so the content can reflow instantly.
 *
 * In Electron, we use the standard `window.resize` event which fires during
 * native resize operations (fullscreen exit, window snapping, drag resize).
 */
const DEBOUNCE_MS = 150;

export function useWindowResizing(): void {
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (!isElectronEnv) return;

    const handleResize = () => {
      document.documentElement.classList.add("window-resizing");
      clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => {
        document.documentElement.classList.remove("window-resizing");
      }, DEBOUNCE_MS);
    };

    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      clearTimeout(timeoutRef.current);
      document.documentElement.classList.remove("window-resizing");
    };
  }, []);
}
