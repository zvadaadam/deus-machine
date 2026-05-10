import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import type { Bounds } from "../webview-manager";
import { MOBILE_PREVIEW_WIDTH } from "../types";

const SPLITTER_GUARD = 6;

export function useRemoteBrowserPanelBounds(isMobileView: boolean): {
  panelContainerRef: RefObject<HTMLDivElement>;
  panelRect: Bounds | null;
  bounds: Bounds | null;
} {
  const panelContainerRef = useRef<HTMLDivElement | null>(null);
  const [panelRect, setPanelRect] = useState<Bounds | null>(null);

  useLayoutEffect(() => {
    const el = panelContainerRef.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      setPanelRect({ x: r.x, y: r.y, width: r.width, height: r.height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, []);

  const bounds = useMemo<Bounds | null>(() => {
    if (!panelRect) return null;
    const available = Math.max(0, panelRect.width - SPLITTER_GUARD * 2);
    const w = isMobileView ? Math.min(MOBILE_PREVIEW_WIDTH, available) : available;
    const x = panelRect.x + (panelRect.width - w) / 2;
    return { x, y: panelRect.y, width: w, height: panelRect.height };
  }, [isMobileView, panelRect]);

  return { panelContainerRef, panelRect, bounds };
}
