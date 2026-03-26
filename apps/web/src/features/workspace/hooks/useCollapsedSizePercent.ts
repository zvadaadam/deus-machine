import { useState, useEffect, useLayoutEffect } from "react";

/**
 * Converts a fixed pixel width to a dynamic percentage of a container.
 *
 * Used with react-resizable-panels' `collapsedSize` prop which requires
 * a percentage value. A ResizeObserver continuously tracks the container
 * width so the percentage stays accurate across window resizes.
 *
 * useLayoutEffect runs a synchronous measurement before first paint to
 * avoid a flash where collapsedSize is an estimate rather than exact.
 */
export function useCollapsedSizePercent(
  containerRef: React.RefObject<HTMLDivElement | null>,
  stripWidthPx: number = 36
): number {
  // Rough estimate for first render — corrected synchronously in useLayoutEffect.
  // 0.65 ≈ panel group's share of window (sidebar ~240px + agent-server ~58px ≈ 35%).
  const [pct, setPct] = useState(() =>
    typeof window !== "undefined" ? (stripWidthPx / (window.innerWidth * 0.65)) * 100 : 3
  );

  // Synchronous measurement before first paint — no flash
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const w = el.getBoundingClientRect().width;
    if (w > 0) setPct((stripWidthPx / w) * 100);
  }, [containerRef, stripWidthPx]);

  // Continuous tracking via ResizeObserver for window/layout changes
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      if (w > 0) setPct((stripWidthPx / w) * 100);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef, stripWidthPx]);

  return pct;
}
