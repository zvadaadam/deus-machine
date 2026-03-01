/**
 * useAutoScroll -- Scroll-position-math approach to chat auto-scroll.
 *
 * One boolean (isPaused) replaces the 3-state machine. The browser already
 * knows the scroll position -- we just read it:
 *
 *   scrollTop + clientHeight >= scrollHeight - THRESHOLD  =>  at bottom.
 *
 * ESCAPE (→ paused):
 *   Wheel-up on the main container (not nested scrollables like code blocks).
 *   The DOM walk finds the nearest scrollable ancestor — only escapes if it's
 *   OUR scroll container.
 *
 * RE-ENGAGE (→ unpaused):
 *   User scrolls back to bottom, clicks the button, sends a message,
 *   or the 10s auto-resume timeout fires.
 *
 * CONTENT GROWTH:
 *   ResizeObserver on the content wrapper. When height grows and !isPaused
 *   and !isSelecting, write scrollTop = scrollHeight. No race condition
 *   guards needed — the scroll listener only checks isAtBottom for
 *   re-engagement (never disengages on scroll events).
 *
 * TEXT SELECTION:
 *   Checks mouseDown + window.getSelection() overlap with the container.
 *   Skips auto-scroll to avoid fighting the selection during streaming.
 *
 * PREPEND (load-older):
 *   Chat.tsx calls syncGeometry() after correcting scrollTop in its
 *   useLayoutEffect. This updates internal refs so the scroll/resize
 *   handlers don't misinterpret the correction as user scroll or content growth.
 *
 * EXPAND/COLLAPSE:
 *   Cursor-aligned: expand/collapse uses conditional render + opacity fade
 *   (no CSS grid height transitions). Expand handlers call the module-level
 *   suppressAutoScrollOnExpand() BEFORE toggling state so the ResizeObserver
 *   doesn't snap to bottom — the clicked element stays in place while content
 *   expands below. Collapse needs no suppression (height shrinks, not grows).
 *
 * Inspired by Cursor IDE's ScrollArea implementation:
 *   - 5px threshold constant
 *   - isPaused flag with 10s auto-resume timeout
 *   - ResizeObserver on both viewport and content
 *   - No IntersectionObserver, no sentinel div
 */

import { useState, useEffect, useCallback, useRef, type RefObject } from "react";
import type { Message } from "@/shared/types";

// ── Constants ────────────────────────────────────────────────────────────

/** Pixels from bottom to consider "at bottom". Matches Cursor's 5px. */
const BOTTOM_THRESHOLD = 5;

/** Auto-resume after this many ms when paused (Cursor: 10s). */
const AUTO_RESUME_MS = 10_000;

// ── Text selection guard (module-level, shared across instances) ─────────
// Tracks mouseDown globally so the hook can skip auto-scroll while the
// user is dragging to select text. Ported from use-stick-to-bottom.

let mouseDown = false;

if (typeof document !== "undefined") {
  document.addEventListener("mousedown", () => {
    mouseDown = true;
  });
  document.addEventListener("mouseup", () => {
    mouseDown = false;
  });
  // Safety net: click fires after mouseup, catches edge cases where mouseup
  // was missed (e.g., mouseup outside the window).
  document.addEventListener("click", () => {
    mouseDown = false;
  });
}

// ── Expand/collapse suppress (module-level, shared across instances) ─────
// When a user clicks to expand a collapsible block, the content mounts and
// grows the container. Without suppression, the ResizeObserver snaps
// scrollTop to scrollHeight, yanking the clicked element out of view.
// The expand handler calls suppressAutoScrollOnExpand() before toggling
// state, and the ResizeObserver skips the resulting growth events.

let _suppressExpandCount = 0;

/**
 * Suppress the next several auto-scroll-on-growth events.
 * Call from expand/collapse click handlers BEFORE toggling state,
 * so the ResizeObserver doesn't misinterpret the height change as
 * streaming content and snap to the bottom.
 *
 * Counter (not boolean) absorbs the burst of resize events from
 * content mounting (virtualizer remeasure + content wrapper resize).
 */
export function suppressAutoScrollOnExpand() {
  _suppressExpandCount += 3;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function isAtBottom(el: HTMLElement): boolean {
  return el.scrollTop + el.clientHeight >= el.scrollHeight - BOTTOM_THRESHOLD;
}

/**
 * Walk up from the wheel event target to find the nearest scrollable ancestor.
 * Returns true only if that scrollable is the given container (meaning the
 * user is scrolling the main chat, not a nested code block or terminal).
 */
function isWheelOnMainContainer(target: EventTarget | null, container: HTMLElement): boolean {
  let el = target as HTMLElement | null;
  while (el) {
    const overflow = getComputedStyle(el).overflowY;
    const isScrollable =
      (overflow === "scroll" || overflow === "auto") && el.scrollHeight > el.clientHeight;
    if (isScrollable) {
      return el === container;
    }
    el = el.parentElement;
  }
  return false;
}

// ── Hook ─────────────────────────────────────────────────────────────────

interface UseAutoScrollOptions {
  messages: Message[];
  messagesContainerRef: RefObject<HTMLDivElement>;
}

export function useAutoScroll({ messages, messagesContainerRef }: UseAutoScrollOptions) {
  // --- Public state ---
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [hasNewMessages, setHasNewMessages] = useState(false);

  // --- Core scroll state: a single boolean ---
  const isPausedRef = useRef(false);
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- Geometry refs ---
  // When Chat.tsx corrects scrollTop after a prepend, the ResizeObserver
  // fires multiple times as the new content renders (one per element in the
  // prepended batch). A boolean only suppresses one callback. A counter
  // (incremented by 3 per syncGeometry call) absorbs the burst.
  const skipGrowthCountRef = useRef(0);

  // --- Message tracking (append vs prepend detection) ---
  const prevMessageCountRef = useRef(messages.length);
  const prevLastMessageIdRef = useRef<string | null>(
    messages.length > 0 ? messages[messages.length - 1].id : null
  );

  // ── Pause / Resume ────────────────────────────────────────────────────

  const pause = useCallback(() => {
    if (isPausedRef.current) return;
    isPausedRef.current = true;
    setShowScrollButton(true);

    // Auto-resume after timeout (Cursor pattern: user scrolls up, forgets,
    // chat gently re-engages after 10s). Only unpauses — does NOT snap to
    // bottom. If the session is streaming, the next ResizeObserver growth
    // event will scroll naturally. If idle, the user stays where they are.
    if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
    resumeTimerRef.current = setTimeout(() => {
      resumeTimerRef.current = null;
      isPausedRef.current = false;
      setShowScrollButton(false);
      setHasNewMessages(false);
    }, AUTO_RESUME_MS);
  }, []);

  const resume = useCallback(() => {
    if (!isPausedRef.current) return;
    isPausedRef.current = false;
    setShowScrollButton(false);
    setHasNewMessages(false);
    if (resumeTimerRef.current) {
      clearTimeout(resumeTimerRef.current);
      resumeTimerRef.current = null;
    }
  }, []);

  // ── Text selection check ──────────────────────────────────────────────

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

  // ── Scroll to bottom ──────────────────────────────────────────────────

  const scrollToBottom = useCallback(
    (smooth = false) => {
      const container = messagesContainerRef.current;
      if (!container) return;
      resume();
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (smooth && !reducedMotion) {
        container.scrollTo({
          top: container.scrollHeight,
          behavior: "smooth",
        });
      } else {
        container.scrollTop = container.scrollHeight;
      }
    },
    [messagesContainerRef, resume]
  );

  /**
   * Suppress the next several ResizeObserver growth callbacks.
   * Call this after any programmatic scrollTop correction (e.g., prepend
   * anchor restore in Chat.tsx useLayoutEffect) so the ResizeObserver
   * doesn't misinterpret the height change as streaming content and
   * stomp the restored scroll position.
   *
   * Increments by 3 to absorb the burst of resize events from prepended
   * content rendering (typically 1-3 elements in a single batch).
   */
  const syncGeometry = useCallback(() => {
    skipGrowthCountRef.current += 3;
  }, []);

  // ── Wheel listener: escape detection ──────────────────────────────────
  // Uses wheel events (not scroll direction) to detect user intent to scroll
  // up. Walks the DOM to distinguish scrolling inside nested scrollables
  // (code blocks, terminal output) from the main chat container.
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      if (e.deltaY >= 0) return; // Only care about scroll-UP (deltaY < 0)
      if (isPausedRef.current) return; // Already paused
      if (isWheelOnMainContainer(e.target, container)) {
        pause();
      }
    };

    container.addEventListener("wheel", handleWheel, { passive: true });
    return () => container.removeEventListener("wheel", handleWheel);
  }, [messagesContainerRef, pause]);

  // ── Scroll listener: re-engagement only ───────────────────────────────
  // When the user scrolls back to within THRESHOLD of the bottom while
  // paused, resume auto-scroll. This is the only job of the scroll handler.
  // Disengagement is handled exclusively by the wheel listener (more
  // reliable for nested scrollables).
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      if (isPausedRef.current && isAtBottom(container)) {
        resume();
      }
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [messagesContainerRef, resume]);

  // ── ResizeObserver: auto-scroll on content growth ─────────────────────
  // Watches the content wrapper (first child of the scroll container).
  // When content height grows and we're not paused, push scrollTop to
  // scrollHeight. Simple and direct — no race condition guards needed
  // because the scroll listener never disengages (only re-engages).
  //
  // `contentReady` re-runs this effect when transitioning from the loading
  // skeleton to the real content wrapper. Without it, the observer would
  // stay attached to the detached skeleton div and never fire again.
  const contentReady = messages.length > 0;
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container || !contentReady) return;

    let prevHeight: number | undefined;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const h = entry.contentRect.height;
      const grew = prevHeight !== undefined && h > prevHeight;
      prevHeight = h;

      if (!grew) return;
      if (skipGrowthCountRef.current > 0) {
        skipGrowthCountRef.current--;
        return;
      }
      if (_suppressExpandCount > 0) {
        _suppressExpandCount--;
        return;
      }
      if (isPausedRef.current) return;
      if (isSelecting()) return;

      // Defer scroll to next frame so the chatItemEnter CSS animation
      // paints its first keyframe before we move scrollTop. Without rAF
      // the scroll write happens mid-ResizeObserver callback, before the
      // browser paints the new content, causing a visual jump.
      requestAnimationFrame(() => {
        const c = messagesContainerRef.current;
        if (c && !isPausedRef.current && !isSelecting()) {
          c.scrollTop = c.scrollHeight;
        }
      });
    });

    const contentWrapper = container.firstElementChild;
    if (contentWrapper) observer.observe(contentWrapper);
    return () => observer.disconnect();
  }, [messagesContainerRef, isSelecting, contentReady]);

  // ── Auto-scroll on new messages ───────────────────────────────────────
  useEffect(() => {
    const count = messages.length;
    const prevCount = prevMessageCountRef.current;
    const lastId = count > 0 ? messages[count - 1].id : null;
    const prevLastId = prevLastMessageIdRef.current;

    prevMessageCountRef.current = count;
    prevLastMessageIdRef.current = lastId;

    if (count <= prevCount) return;

    // Prepend: count grew but last message unchanged — don't auto-scroll.
    // Chat.tsx's useLayoutEffect handles scroll position preservation.
    if (lastId === prevLastId) return;

    const latest = messages[count - 1];
    const isUserMessage = latest?.role === "user";

    if (isUserMessage) {
      // User sent a message — always scroll to bottom, even if paused.
      resume();
      requestAnimationFrame(() => {
        const c = messagesContainerRef.current;
        if (c) c.scrollTop = c.scrollHeight;
      });
      return;
    }

    // Assistant message while paused — show "new messages" indicator.
    if (isPausedRef.current) {
      setHasNewMessages(true);
    }
    // If not paused, ResizeObserver handles the scroll automatically
    // when the new message content renders and grows the container.
  }, [messages, messagesContainerRef, resume]);

  // ── Cleanup ───────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
    };
  }, []);

  // ── Public API ────────────────────────────────────────────────────────

  const handleScrollToBottomClick = useCallback(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    scrollToBottom(!reducedMotion);
  }, [scrollToBottom]);

  return {
    showScrollButton,
    hasNewMessages,
    scrollToBottom,
    handleScrollToBottomClick,
    syncGeometry,
  };
}
