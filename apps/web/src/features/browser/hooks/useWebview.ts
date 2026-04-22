/**
 * useWebview — declaratively sync a <webview> instance to React-owned state.
 *
 * Caller computes the target bounds from its own layout (ResizeObserver on
 * a panel container, viewport emulation math, etc.) and passes them in.
 * The hook does one thing: on every commit, call `instance.sync(bounds,
 * isVisible)`. No DOM measurement, no ResizeObserver, no rAF gymnastics.
 * All the stability (mid-transition fallback to last visible bounds) is
 * inside WebviewInstance.sync() — see webview-manager.ts.
 */
/* eslint-env browser */

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import {
  type Bounds,
  type WebviewElement,
  type WebviewInstance,
  webviewManager,
} from "../webview-manager";

interface UseWebviewOptions {
  /** Stable id — usually the tab id. Reused across re-renders. */
  id: string;
  /** URL used on first instantiation only. Later navigation goes through
   *  the returned webview element's imperative API (loadURL, goBack, …). */
  initialUrl: string;
  /** Target bounds for the <webview> container, or null while the caller
   *  has no layout yet (e.g. before first ResizeObserver fire). */
  bounds: Bounds | null;
  /** Whether the panel hosting this tab is currently visible. */
  isVisible: boolean;
}

interface UseWebviewResult {
  /** Imperative access to the <webview> element. Stable across re-renders. */
  getWebview: () => WebviewElement | null;
  /** Access the underlying instance for event subscription. */
  getInstance: () => WebviewInstance | null;
}

export function useWebview({
  id,
  initialUrl,
  bounds,
  isVisible,
}: UseWebviewOptions): UseWebviewResult {
  const instanceRef = useRef<WebviewInstance | null>(null);
  if (instanceRef.current === null) {
    instanceRef.current = webviewManager.getOrCreate(id, initialUrl);
  }

  // Single sync point — writes container style synchronously at commit time.
  useLayoutEffect(() => {
    instanceRef.current?.sync({ bounds, isVisible });
  }, [bounds, isVisible]);

  // Detach on unmount. The instance stays alive in the manager so tab switches
  // don't tear down the guest page; explicit disposal happens via
  // `webviewManager.dispose(id)` from close-tab handlers.
  useEffect(() => {
    return () => instanceRef.current?.detach();
  }, []);

  const getWebview = useCallback<() => WebviewElement | null>(
    () => instanceRef.current?.webview ?? null,
    []
  );
  const getInstance = useCallback<() => WebviewInstance | null>(() => instanceRef.current, []);

  return { getWebview, getInstance };
}
