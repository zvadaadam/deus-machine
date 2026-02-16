/**
 * useAutoScroll Hook - State Machine + Observer-Based Auto-Scroll
 *
 * Manages chat auto-scroll using a 3-state machine and browser observers
 * instead of brittle scroll-position math:
 *
 * STATE MACHINE:
 *   AT_BOTTOM          -- User is at the bottom. Auto-scroll on new content.
 *   READING_HISTORY    -- User scrolled up intentionally. No auto-scroll.
 *   SCROLLING_TO_BOTTOM -- Programmatic scroll in progress. Ignore scroll events
 *                          to prevent button flicker.
 *
 * OBSERVERS:
 *   IntersectionObserver -- Watches the sentinel div (messagesEndRef) to know
 *                           if the user is truly "at bottom" without scroll math.
 *   ResizeObserver       -- Watches the messages container for height changes
 *                           (markdown rendering, tool results expanding, code
 *                           blocks appearing). Triggers auto-scroll when content
 *                           grows while user is at bottom.
 *
 * PROTECTIONS (ported from use-stick-to-bottom):
 *   Text selection   -- Pauses auto-scroll while user is dragging to select text
 *                       inside the chat, preventing the scroll from fighting the
 *                       selection during streaming.
 *   Wheel escape     -- Uses wheel events (not scroll direction) to detect user
 *                       intent to scroll up. Walks the DOM to distinguish scrolling
 *                       inside nested scrollables (code blocks) from the main chat.
 *   Resize guard     -- Tracks content height deltas to prevent resize-triggered
 *                       scroll events from being misinterpreted as user scroll-ups.
 */

import { useState, useEffect, useCallback, useRef, RefObject } from "react";
import type { Message } from "@/shared/types";

// ---------------------------------------------------------------------------
// Text selection protection (module-level singleton, shared across instances)
// Ported from use-stick-to-bottom: tracks mousedown globally so the hook can
// skip auto-scroll while the user is dragging to select text.
// ---------------------------------------------------------------------------
let mouseDown = false;

if (typeof document !== "undefined") {
  document.addEventListener("mousedown", () => { mouseDown = true; });
  document.addEventListener("mouseup", () => { mouseDown = false; });
  // Safety net: click fires after mouseup, catches edge cases where mouseup
  // was missed (e.g., mouseup outside the window).
  document.addEventListener("click", () => { mouseDown = false; });
}

/**
 * Scroll state machine states.
 *
 * AT_BOTTOM: Sentinel is visible. Auto-scroll on content changes.
 * READING_HISTORY: User scrolled up. Show scroll-to-bottom button.
 * SCROLLING_TO_BOTTOM: Programmatic scroll in flight. Suppress scroll events.
 */
type ScrollState = "AT_BOTTOM" | "READING_HISTORY" | "SCROLLING_TO_BOTTOM";

interface UseAutoScrollOptions {
  messages: Message[];
  messagesContainerRef: RefObject<HTMLDivElement>;
  messagesEndRef: RefObject<HTMLDivElement>;
  scrollThreshold?: number; // Kept for API compat, unused internally
}

/** Duration to suppress scroll events after a smooth scroll (ms). */
const SMOOTH_SCROLL_SETTLE_MS = 300;
/** Duration to suppress scroll events after an instant scroll (ms). */
const INSTANT_SCROLL_SETTLE_MS = 50;

export function useAutoScroll({
  messages,
  messagesContainerRef,
  messagesEndRef,
}: UseAutoScrollOptions) {
  // --- Core state ---
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [hasNewMessages, setHasNewMessages] = useState(false);

  // Refs for values that observers/timers need without triggering re-renders.
  const scrollStateRef = useRef<ScrollState>("AT_BOTTOM");
  const sentinelVisibleRef = useRef(true);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track scroll direction to detect intentional upward scrolls.
  // Any upward scroll = user intent to read history, regardless of sentinel visibility.
  const lastScrollTopRef = useRef(0);

  // Track previous message count to detect new messages vs. content reflows.
  const prevMessageCountRef = useRef(messages.length);

  // Resize-vs-scroll race condition guard (ported from use-stick-to-bottom).
  // When content resizes, the browser may fire a scroll event before/after the
  // ResizeObserver callback. Without this guard, the scroll handler sees
  // scrollTop change and misinterprets it as a user scroll-up.
  const resizeDifferenceRef = useRef(0);

  // --- Helpers ---

  /**
   * Check if the user is actively selecting text inside the scroll container.
   * Ported from use-stick-to-bottom: prevents auto-scroll from fighting text
   * selection during streaming. Requires both mouseDown AND an active selection
   * range that overlaps with the scroll container.
   */
  const isSelecting = useCallback(() => {
    if (!mouseDown) return false;
    const container = messagesContainerRef.current;
    if (!container) return false;

    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return false;

    const range = selection.getRangeAt(0);
    const ancestor = range.commonAncestorContainer;
    return ancestor.contains(container) || container.contains(ancestor);
  }, [messagesContainerRef]);

  /** Transition the scroll state and sync the button visibility. */
  const transitionTo = useCallback((next: ScrollState) => {
    scrollStateRef.current = next;
    setShowScrollButton(next === "READING_HISTORY");
    // Clear "new messages" indicator when user returns to bottom
    if (next === "AT_BOTTOM") setHasNewMessages(false);
  }, []);

  /** Check prefers-reduced-motion once per call (cheap matchMedia check). */
  const prefersReducedMotion = useCallback(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    []
  );

  /**
   * Scroll the container to its absolute bottom.
   * Uses scrollTop/scrollTo instead of scrollIntoView because the sentinel
   * sits inside a pb-32 wrapper — scrollIntoView stops at the sentinel,
   * leaving 128px of padding unscrolled.
   */
  const scrollToBottom = useCallback(
    (smooth = false) => {
      const container = messagesContainerRef.current;
      if (!container) return;

      // Clear any pending settle timer from a previous scroll call.
      if (settleTimerRef.current !== null) {
        clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }

      const useSmooth = smooth && !prefersReducedMotion();
      transitionTo("SCROLLING_TO_BOTTOM");

      if (useSmooth) {
        container.scrollTo({
          top: container.scrollHeight,
          behavior: "smooth",
        });
      } else {
        container.scrollTop = container.scrollHeight;
      }

      // After the scroll animation settles, read the observer to pick next state.
      const delay = useSmooth ? SMOOTH_SCROLL_SETTLE_MS : INSTANT_SCROLL_SETTLE_MS;
      settleTimerRef.current = setTimeout(() => {
        settleTimerRef.current = null;
        transitionTo(sentinelVisibleRef.current ? "AT_BOTTOM" : "READING_HISTORY");
      }, delay);
    },
    [messagesContainerRef, transitionTo, prefersReducedMotion]
  );

  // --- IntersectionObserver: sentinel visibility ---
  useEffect(() => {
    const sentinel = messagesEndRef.current;
    const container = messagesContainerRef.current;
    if (!sentinel || !container) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        const isVisible = entry.isIntersecting && entry.intersectionRatio > 0.1;
        sentinelVisibleRef.current = isVisible;

        // Only RE-ENGAGE (→ AT_BOTTOM) from the IO, never disengage (→ READING_HISTORY).
        // Content growth pushes the sentinel out of view — the IO sees "not visible"
        // but that's NOT the user scrolling up. Disengagement is handled exclusively
        // by the wheel listener detecting actual upward wheel events.
        if (isVisible && scrollStateRef.current !== "SCROLLING_TO_BOTTOM") {
          transitionTo("AT_BOTTOM");
        }
      },
      {
        root: container,
        // Tight margin — only consider sentinel visible when truly near the bottom.
        // A generous margin (e.g. 40px) caused auto-scroll to stay engaged even
        // when the user scrolled up slightly, making it feel too "sticky".
        rootMargin: "0px 0px 8px 0px",
        threshold: [0, 0.1, 1],
      }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [messagesContainerRef, messagesEndRef, transitionTo]);

  // --- ResizeObserver: auto-scroll on content height changes ---
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    let rafId: number | null = null;
    let previousHeight: number | undefined;

    const observer = new ResizeObserver((entries) => {
      // Batch with rAF to avoid layout thrashing when multiple children resize
      // in the same frame (e.g., several markdown blocks rendering at once).
      if (rafId !== null) return;

      // Track height delta for the resize-vs-scroll race condition guard.
      const entry = entries[0];
      if (entry) {
        const currentHeight = entry.contentRect.height;
        const difference = currentHeight - (previousHeight ?? currentHeight);
        previousHeight = currentHeight;
        resizeDifferenceRef.current = difference;

        // Reset the guard after the scroll event has had a chance to fire.
        // rAF + setTimeout(1) ensures we clear AFTER both the scroll event
        // and any microtasks from the resize (see WICG/resize-observer#25).
        requestAnimationFrame(() => {
          setTimeout(() => {
            if (resizeDifferenceRef.current === difference) {
              resizeDifferenceRef.current = 0;
            }
          }, 1);
        });
      }

      // Capture scroll intent NOW, before the IO can react to the layout change.
      // Per spec, ResizeObserver fires before IntersectionObserver in the same
      // frame. If we read the state inside the rAF callback, the IO may have
      // already transitioned to READING_HISTORY (sentinel pushed out of view
      // by content growth), causing a false skip.
      const shouldScroll = scrollStateRef.current !== "READING_HISTORY";

      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (shouldScroll && !isSelecting()) {
          container.scrollTop = container.scrollHeight;
        }
      });
    });

    // Observe the first child (the actual content wrapper) rather than the
    // scroll container itself. This fires on content growth, not on scroll.
    // The Chat component wraps messages in a flex-col div with pb-32.
    const contentWrapper = container.firstElementChild;
    if (contentWrapper) {
      observer.observe(contentWrapper);
    }

    return () => {
      observer.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [messagesContainerRef, isSelecting]);

  // --- Wheel event listener: escape detection (ported from use-stick-to-bottom) ---
  // Uses wheel events instead of scroll-direction math. This correctly handles
  // nested scrollable elements (code blocks, terminal output): the DOM walk
  // finds the nearest scrollable ancestor of the event target and only escapes
  // if it's OUR scroll container. Scroll events can't distinguish this.
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      if (scrollStateRef.current === "SCROLLING_TO_BOTTOM") return;
      if (e.deltaY >= 0) return; // Only care about scroll-UP (deltaY < 0)

      // Walk up from the event target to find the nearest scrollable ancestor.
      // If it's not our container, the user is scrolling inside a nested
      // scrollable (code block, terminal, etc.) — don't escape.
      let el = e.target as HTMLElement | null;
      while (el) {
        const overflow = getComputedStyle(el).overflowY;
        if (overflow === "scroll" || overflow === "auto") {
          // Found the nearest scrollable ancestor
          if (el === container) {
            // User is scrolling up in OUR container → escape from auto-scroll
            if (scrollStateRef.current === "AT_BOTTOM") {
              transitionTo("READING_HISTORY");
            }
          }
          // Either way, stop walking — we found the relevant scrollable
          return;
        }
        el = el.parentElement;
      }
    };

    container.addEventListener("wheel", handleWheel, { passive: true });
    return () => container.removeEventListener("wheel", handleWheel);
  }, [messagesContainerRef, transitionTo]);

  // --- Scroll event listener: detect re-engagement (scrolling back to bottom) ---
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      // Suppress scroll events during programmatic scrolls to prevent
      // the scroll-to-bottom button from flickering on/off.
      if (scrollStateRef.current === "SCROLLING_TO_BOTTOM") return;

      // If there's a pending resize difference, this scroll event was triggered
      // by a content resize (not by the user). Ignore it to prevent false
      // disengagement. (Ported from use-stick-to-bottom.)
      if (resizeDifferenceRef.current !== 0) return;

      const currentTop = container.scrollTop;
      const scrolledDown = currentTop > lastScrollTopRef.current;
      lastScrollTopRef.current = currentTop;

      // RE-ENGAGEMENT: user scrolled back to bottom.
      // Math-based check (like Cursor's approach) as a fast path.
      // The IO will also fire but is async; this gives immediate re-engagement.
      // Note: Disengagement is now handled by the wheel listener (more reliable
      // than scroll-direction for distinguishing nested scrollables).
      if (scrolledDown && scrollStateRef.current === "READING_HISTORY") {
        const atBottom =
          container.scrollTop + container.clientHeight >= container.scrollHeight - 16;
        if (atBottom) {
          transitionTo("AT_BOTTOM");
        }
      }
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [messagesContainerRef, transitionTo]);

  // --- Auto-scroll on new messages ---
  useEffect(() => {
    const count = messages.length;
    const prevCount = prevMessageCountRef.current;
    prevMessageCountRef.current = count;

    if (count <= prevCount) return;

    // Always scroll to bottom when the USER sends a message, even if
    // they were reading history. They expect to see their own message.
    const latestMessage = messages[messages.length - 1];
    const isUserMessage = latestMessage?.role === "user";

    if (isUserMessage) {
      // Set ref synchronously so ResizeObserver reads the correct state before
      // any observers fire. The setState via transitionTo goes in the rAF to
      // satisfy the lint rule (no setState in effect body).
      scrollStateRef.current = "AT_BOTTOM";
      requestAnimationFrame(() => {
        transitionTo("AT_BOTTOM");
        const container = messagesContainerRef.current;
        if (container) container.scrollTop = container.scrollHeight;
      });
      return;
    }

    // For assistant messages, only auto-scroll if user is at bottom.
    if (scrollStateRef.current === "READING_HISTORY") {
      // User is scrolled up — flag new messages for the pill indicator
      requestAnimationFrame(() => {
        setHasNewMessages(true);
      });
    } else {
      requestAnimationFrame(() => {
        const container = messagesContainerRef.current;
        if (container) container.scrollTop = container.scrollHeight;
      });
    }
  }, [messages, messagesContainerRef, transitionTo]);

  // --- Cleanup settle timer on unmount ---
  useEffect(() => {
    return () => {
      if (settleTimerRef.current !== null) {
        clearTimeout(settleTimerRef.current);
      }
    };
  }, []);

  // --- Public API (unchanged from previous hook) ---

  /** Manual "scroll to bottom" button click. Always scrolls, resets state. */
  const handleScrollToBottomClick = useCallback(() => {
    const smooth = !prefersReducedMotion();
    scrollToBottom(smooth);
  }, [scrollToBottom, prefersReducedMotion]);

  return {
    showScrollButton,
    hasNewMessages,
    scrollToBottom,
    handleScrollToBottomClick,
  };
}
