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
 * This replaces the old approach of:
 *   - A 100px threshold that broke at different zoom levels
 *   - No ResizeObserver (scroll jumped when content reflowed)
 *   - Scroll events firing during smooth-scroll animation (button flicker)
 */

import { useState, useEffect, useCallback, useRef, RefObject } from "react";
import type { Message } from "@/shared/types";

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

  // --- Helpers ---

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
        // by the scroll listener detecting actual upward scrolls.
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

    const observer = new ResizeObserver(() => {
      // Batch with rAF to avoid layout thrashing when multiple children resize
      // in the same frame (e.g., several markdown blocks rendering at once).
      if (rafId !== null) return;

      // Capture scroll intent NOW, before the IO can react to the layout change.
      // Per spec, ResizeObserver fires before IntersectionObserver in the same
      // frame. If we read the state inside the rAF callback, the IO may have
      // already transitioned to READING_HISTORY (sentinel pushed out of view
      // by content growth), causing a false skip.
      const shouldScroll = scrollStateRef.current !== "READING_HISTORY";

      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (shouldScroll) {
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
  }, [messagesContainerRef]);

  // --- Scroll event listener: detect manual user scrolling ---
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      // Suppress scroll events during programmatic scrolls to prevent
      // the scroll-to-bottom button from flickering on/off.
      if (scrollStateRef.current === "SCROLLING_TO_BOTTOM") return;

      const currentTop = container.scrollTop;
      const scrolledUp = currentTop < lastScrollTopRef.current;
      const scrolledDown = currentTop > lastScrollTopRef.current;
      lastScrollTopRef.current = currentTop;

      // --- DISENGAGEMENT: upward scroll = user intent to read history ---
      // Catches the case BEFORE the IntersectionObserver fires (IO is async)
      // and prevents the ResizeObserver from yanking the user back down.
      if (scrolledUp && scrollStateRef.current === "AT_BOTTOM") {
        transitionTo("READING_HISTORY");
        return;
      }

      // --- RE-ENGAGEMENT: user scrolled back to bottom ---
      // Math-based check (like Cursor's approach) as a fast path.
      // The IO will also fire but is async; this gives immediate re-engagement.
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
