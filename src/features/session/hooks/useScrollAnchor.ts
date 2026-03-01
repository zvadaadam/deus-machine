/**
 * useScrollAnchor -- Preserves visual scroll position across animated height changes.
 *
 * Problem: When a collapsible section expands/collapses inside a scrollable
 * container, content shifts and the element the user clicked jumps to a
 * different visual position. CSS grid transitions (0fr -> 1fr) animate the
 * height over ~200ms, so the shift happens gradually and can't be corrected
 * with a single scrollTop adjustment.
 *
 * Solution: Capture the toggle button's viewport offset BEFORE the toggle.
 * Then, during the CSS transition, a per-frame rAF loop continuously
 * re-measures the button position and adjusts scrollTop to compensate for
 * drift. This keeps the clicked element visually stationary while the
 * content around it expands or collapses.
 *
 * Why per-frame correction instead of one-shot:
 * CSS grid-template-rows transitions interpolate height over multiple frames.
 * A single correction (e.g., in useLayoutEffect) fires before the transition
 * starts, when the computed height hasn't changed yet. The rAF loop corrects
 * each interpolated frame.
 *
 * Why this lives in collapsible components, not in useAutoScroll:
 * Only the click handler knows "the user toggled a collapsible." The
 * ResizeObserver in useAutoScroll sees "content height changed" with no way
 * to distinguish expand/collapse from streaming. By anchoring in the
 * component, we separate the two concerns cleanly.
 */

/**
 * Captures a scroll anchor and runs a per-frame correction loop during
 * the CSS transition to keep the anchored element visually stationary.
 *
 * Call this synchronously in the click handler, BEFORE calling setState
 * to toggle the collapsible.
 *
 * @param element - The DOM element to anchor (typically the toggle button).
 *                  Must remain in the DOM throughout the transition.
 * @param scrollContainer - The scrollable container (e.g., #chat-messages).
 * @param durationMs - How long to run the correction loop (should match or
 *                     slightly exceed the CSS transition duration). Default 250ms.
 */
export function anchorAndCorrect(
  element: Element,
  scrollContainer: HTMLElement,
  durationMs = 250
): void {
  const initialOffset = element.getBoundingClientRect().top;
  const startTime = performance.now();
  let rafId: number | null = null;

  const correct = () => {
    const currentOffset = element.getBoundingClientRect().top;
    const drift = currentOffset - initialOffset;

    if (Math.abs(drift) > 0.5) {
      scrollContainer.scrollTop += drift;
    }

    // Continue correcting until the transition duration has elapsed.
    // Add a small buffer (50ms) to catch the final frame.
    if (performance.now() - startTime < durationMs + 50) {
      rafId = requestAnimationFrame(correct);
    }
  };

  rafId = requestAnimationFrame(correct);

  // Safety: if the component unmounts, the rAF is orphaned but harmless --
  // getBoundingClientRect on a detached element returns zeros, drift is
  // large, but scrollContainer may also be gone. The loop self-terminates
  // after durationMs anyway.
  //
  // We don't return a cleanup function because the caller (click handler)
  // can't run cleanup. The time-bounded loop is the safety mechanism.
  void rafId;
}

/**
 * Returns the chat scroll container (#chat-messages).
 * Used by collapsible click handlers to pass the container to anchorAndCorrect().
 */
export function findScrollContainer(): HTMLElement | null {
  return document.getElementById("chat-messages");
}
