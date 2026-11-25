/**
 * useAutoScroll — rAF chase loop for smooth chat auto-scroll.
 *
 * CHASE LOOP: Runs at 60fps when !isPaused.
 *   scrollTop += (target - scrollTop) * CHASE_FACTOR each frame.
 *
 * PAUSE: Detected inside the chase loop itself.
 *   If scrollTop decreased since our last write AND not near bottom → pause.
 *   Works for ALL input methods (wheel, scrollbar, keyboard, touch).
 *
 * RESUME:
 *   - User scrolls back to bottom (scroll event, after cooldown)
 *   - User sends a new message
 *   - User clicks "scroll to bottom" button
 */

import { useState, useEffect, useCallback, useRef, type RefObject } from "react";

// ── Constants ────────────────────────────────────────────────────────────

const BOTTOM_THRESHOLD = 24;
const PAUSE_COOLDOWN_MS = 500;
const CHASE_FACTOR = 0.25;
const GRACE_FRAMES = 15; // ~250ms — absorbs trackpad inertia after resume

// ── Debug logging ────────────────────────────────────────────────────────
const DEBUG = false;
const log = (...args: unknown[]) => {
  if (DEBUG) console.log("[autoscroll]", ...args);
};

// ── Helpers ──────────────────────────────────────────────────────────────

const reducedMotionQuery =
  typeof window !== "undefined" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;

function isAtBottom(el: HTMLElement): boolean {
  return el.scrollTop + el.clientHeight >= el.scrollHeight - BOTTOM_THRESHOLD;
}

// ── Hook ─────────────────────────────────────────────────────────────────

interface UseAutoScrollOptions {
  running: boolean;
  contentCount: number;
  lastContentId: string | null;
  messagesContainerRef: RefObject<HTMLDivElement>;
  /** Incremented by the UI when the human clicks Send. Triggers resume + jump to bottom. */
  userSendCount: number;
}

export function useAutoScroll({
  running,
  contentCount,
  lastContentId,
  messagesContainerRef,
  userSendCount,
}: UseAutoScrollOptions) {
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [transcriptNode, setTranscriptNode] = useState<HTMLElement | null>(null);
  const [liveTailNode, setLiveTailNode] = useState<HTMLElement | null>(null);

  const isPausedRef = useRef(false);
  const pausedAtRef = useRef(0);
  const chaseRafRef = useRef<number | null>(null);
  const lastScrollTopRef = useRef(0);

  const prevContentCountRef = useRef(contentCount);
  const prevLastContentIdRef = useRef<string | null>(lastContentId);

  // ── Chase loop ──────────────────────────────────────────────────────

  const pauseFromLoop = useCallback(() => {
    log("PAUSE (from loop) — user scroll detected");
    isPausedRef.current = true;
    pausedAtRef.current = Date.now();
    setShowScrollButton(true);
  }, []);

  const startChase = useCallback(
    ({ grace = false }: { grace?: boolean } = {}) => {
      if (chaseRafRef.current !== null) {
        log("startChase: already running, skip");
        return;
      }

      log("startChase: starting new chase loop, grace:", grace);

      let idleFrames = 0;
      let lastWrittenScrollTop = -1;
      let prevTarget = -1;
      let upwardAccum = 0;
      let graceFrames = grace ? GRACE_FRAMES : 0;
      let tickCount = 0;

      const tick = () => {
        const el = messagesContainerRef.current;
        if (!el || isPausedRef.current) {
          log("tick: exit — el:", !!el, "isPaused:", isPausedRef.current);
          chaseRafRef.current = null;
          return;
        }

        tickCount++;

        const scrollTop = el.scrollTop;
        const scrollHeight = el.scrollHeight;
        const clientHeight = el.clientHeight;
        const target = Math.max(0, scrollHeight - clientHeight);
        const distance = target - scrollTop;

        // Account for geometry shrink (e.g. a settled turn folding under "Worked"
        // or the viewport growing) before attributing upward movement to the user.
        const shrink = prevTarget >= 0 ? Math.max(0, prevTarget - target) : 0;
        prevTarget = target;

        // Log every 30th tick to avoid spam, but always log key events
        const shouldLogTick = tickCount % 30 === 1;

        // ── In-loop pause detection ──────────────────────────────────
        if (graceFrames > 0) {
          graceFrames--;
          upwardAccum = 0;
          if (shouldLogTick) {
            log(
              `tick ${tickCount}: grace=${graceFrames}, scrollTop=${Math.round(scrollTop)}, lastWritten=${Math.round(lastWrittenScrollTop)}, distance=${Math.round(distance)}`
            );
          }
        } else if (lastWrittenScrollTop >= 0) {
          const expectedMin = Math.max(0, lastWrittenScrollTop - shrink);
          const nearBottom = scrollTop + clientHeight >= scrollHeight - 5;

          if (scrollTop < expectedMin) {
            upwardAccum += expectedMin - scrollTop;
            log(
              `tick ${tickCount}: BACKWARD DETECTED — scrollTop=${Math.round(scrollTop)}, expectedMin=${Math.round(expectedMin)}, accum=${Math.round(upwardAccum)}, nearBottom=${nearBottom}`
            );
            if (upwardAccum > 2 && !nearBottom) {
              log(`tick ${tickCount}: → PAUSING (accumulated upward=${Math.round(upwardAccum)}px)`);
              lastScrollTopRef.current = scrollTop;
              pauseFromLoop();
              chaseRafRef.current = null;
              return;
            }
            if (!nearBottom) {
              // Hold position on a sub-threshold upward step rather than
              // overriding it forward, so subsequent 1px ticks accumulate.
              lastWrittenScrollTop = scrollTop;
              lastScrollTopRef.current = scrollTop;
              chaseRafRef.current = requestAnimationFrame(tick);
              return;
            }
          } else if (scrollTop > lastWrittenScrollTop + 1 || nearBottom) {
            upwardAccum = 0;
          } else if (shouldLogTick) {
            log(
              `tick ${tickCount}: scrollTop=${Math.round(scrollTop)}, lastWritten=${Math.round(lastWrittenScrollTop)}, distance=${Math.round(distance)}, target=${Math.round(target)}`
            );
          }
        }

        // ── Chase toward bottom ──────────────────────────────────────
        // Snap when close enough or when the step is too small to move pixels
        if (distance < 1) {
          if (distance > 0) el.scrollTop = target;
          lastScrollTopRef.current = el.scrollTop;
          if (++idleFrames >= 10) {
            log(`tick ${tickCount}: idle self-stop (10 idle frames)`);
            chaseRafRef.current = null;
            return;
          }
          lastWrittenScrollTop = el.scrollTop;
          chaseRafRef.current = requestAnimationFrame(tick);
          return;
        }

        if (reducedMotionQuery?.matches) {
          el.scrollTop = target;
        } else {
          const prev = el.scrollTop;
          el.scrollTop += distance * CHASE_FACTOR;
          // Browser rounds scrollTop — if the write didn't actually move, snap
          if (el.scrollTop === prev) {
            el.scrollTop = target;
          }
        }

        // Count as idle if scroll position didn't change (already at target)
        if (el.scrollTop === lastWrittenScrollTop) {
          if (++idleFrames >= 10) {
            log(`tick ${tickCount}: idle self-stop (stalled)`);
            lastScrollTopRef.current = el.scrollTop;
            chaseRafRef.current = null;
            return;
          }
        } else {
          idleFrames = 0;
        }

        lastWrittenScrollTop = el.scrollTop;
        lastScrollTopRef.current = el.scrollTop;
        chaseRafRef.current = requestAnimationFrame(tick);
      };

      chaseRafRef.current = requestAnimationFrame(tick);
    },
    [messagesContainerRef, pauseFromLoop]
  );

  const stopChase = useCallback(() => {
    if (chaseRafRef.current !== null) {
      log("stopChase: cancelling rAF");
      cancelAnimationFrame(chaseRafRef.current);
      chaseRafRef.current = null;
    }
  }, []);

  // ── Resume ──────────────────────────────────────────────────────────

  const resume = useCallback(() => {
    log("RESUME — isPaused was:", isPausedRef.current);
    isPausedRef.current = false;
    setShowScrollButton(false);
    stopChase();
    startChase({ grace: true });
  }, [startChase, stopChase]);

  // ── Scroll to bottom ───────────────────────────────────────────────

  const scrollToBottom = useCallback(() => {
    log("scrollToBottom clicked");
    resume();
  }, [resume]);

  const syncScrollPosition = useCallback(
    (scrollTop: number, { pauseIfAway = false }: { pauseIfAway?: boolean } = {}) => {
      const container = messagesContainerRef.current;
      lastScrollTopRef.current = scrollTop;
      if (!container) return;
      if (pauseIfAway && !isAtBottom(container)) {
        stopChase();
        isPausedRef.current = true;
        pausedAtRef.current = Date.now();
        setShowScrollButton(true);
      }
    },
    [messagesContainerRef, stopChase]
  );

  // ── Scroll listener: pause detection + re-engagement ────────────────
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    lastScrollTopRef.current = container.scrollTop;
    let recheck: ReturnType<typeof setTimeout>;
    const handleScroll = () => {
      clearTimeout(recheck);
      const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
      if (lastScrollTopRef.current > maxScrollTop) {
        lastScrollTopRef.current = maxScrollTop;
      }
      const currentScrollTop = container.scrollTop;
      const movedUp = currentScrollTop < lastScrollTopRef.current - 2;
      if (currentScrollTop > lastScrollTopRef.current) {
        lastScrollTopRef.current = currentScrollTop;
      }

      if (!isPausedRef.current) {
        // Chase loop may have self-stopped (idle at bottom). If the user
        // then scrolls upward away from bottom, pause NOW — otherwise the
        // next update would yank them back. Require an actual upward move
        // (accumulated against the baseline so 1px trackpad ticks still trip
        // it) so content growing below the fold never triggers a false pause.
        if (chaseRafRef.current === null && movedUp && !isAtBottom(container)) {
          log("scroll listener: chase idle + scrolled up → PAUSE");
          lastScrollTopRef.current = currentScrollTop;
          isPausedRef.current = true;
          pausedAtRef.current = Date.now();
          setShowScrollButton(true);
        }
        return;
      }

      // Already paused — check for re-engagement (scroll back to bottom)
      if (!isAtBottom(container)) return;
      const remaining = PAUSE_COOLDOWN_MS - (Date.now() - pausedAtRef.current);
      if (remaining > 0) recheck = setTimeout(handleScroll, remaining);
      else resume();
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      clearTimeout(recheck);
      container.removeEventListener("scroll", handleScroll);
    };
  }, [messagesContainerRef, resume]);

  // ── Live tail & viewport observer ───────────────────────────────────
  // Scoped strictly to live tail growth (active turn streaming tokens,
  // tell_user bubbles, cards) and viewport size changes (keyboard, panel
  // resize). Settled turns (e.g. opening "Worked") and prepended history
  // are never observed here so they cannot yank the reader to the bottom.
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const container = messagesContainerRef.current;
    if (!container) return;

    let prevWidth = container.clientWidth;
    let prevHeight = container.clientHeight;

    const observer = new ResizeObserver((entries) => {
      let shouldFollow = false;
      for (const entry of entries) {
        if (entry.target === container) {
          const width = container.clientWidth;
          const height = container.clientHeight;
          if (width !== prevWidth || height !== prevHeight) {
            prevWidth = width;
            prevHeight = height;
            shouldFollow = true;
          }
        } else if (entry.target === liveTailNode) {
          shouldFollow = true;
        }
      }
      if (!shouldFollow || isPausedRef.current || chaseRafRef.current !== null) return;
      if (!isAtBottom(container)) {
        log("ResizeObserver: live tail or viewport changed while following — restarting chase");
        startChase();
      }
    });

    observer.observe(container);
    if (liveTailNode) observer.observe(liveTailNode);
    return () => observer.disconnect();
  }, [liveTailNode, messagesContainerRef, startChase]);

  // A turn can reveal its answer without adding a message, and the real
  // transcript wrapper can replace a loading placeholder with the same count.
  const contentReady = contentCount > 0 && transcriptNode !== null;
  useEffect(() => {
    stopChase();
    if (contentReady && !isPausedRef.current) startChase();
  }, [contentReady, running, startChase, stopChase]);

  // ── Human send → resume ────────────────────────────────────────────
  // Triggered by SessionPanel incrementing userSendCount when the human
  // actually clicks Send. NOT triggered by agent-server tool_results (which
  // also have role="user" in the Claude SDK format).
  const prevSendCountRef = useRef(userSendCount);
  useEffect(() => {
    if (userSendCount === prevSendCountRef.current) return;
    prevSendCountRef.current = userSendCount;

    log("userSendCount changed — human sent a message");
    const container = messagesContainerRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
      lastScrollTopRef.current = container.scrollTop;
    }
    resume();
  }, [userSendCount, messagesContainerRef, resume]);

  // ── New message handling ────────────────────────────────────────────
  // Never resumes — only restarts chase when not paused.
  // Resume is handled exclusively by: human send, scroll-to-bottom click,
  // or scroll re-engagement (scrolling back to bottom).
  useEffect(() => {
    const count = contentCount;
    const prevCount = prevContentCountRef.current;
    const lastId = lastContentId;
    const prevLastId = prevLastContentIdRef.current;

    prevContentCountRef.current = count;
    prevLastContentIdRef.current = lastId;

    if (count <= prevCount) return;
    if (lastId === prevLastId) {
      log("message effect: prepend detected, ignoring");
      return;
    }

    const delta = count - prevCount;
    log(
      `message effect: count ${prevCount}→${count} (delta=${delta}), isPaused=${isPausedRef.current}`
    );

    if (!isPausedRef.current) {
      log("message effect: restarting chase");
      stopChase();
      startChase();
    } else {
      log("message effect: paused — ignoring");
    }
  }, [contentCount, lastContentId, startChase, stopChase]);

  // ── Cleanup ─────────────────────────────────────────────────────────
  useEffect(() => () => stopChase(), [stopChase]);

  return {
    showScrollButton,
    handleScrollToBottomClick: scrollToBottom,
    transcriptRef: setTranscriptNode,
    liveTailRef: setLiveTailNode,
    syncScrollPosition,
  };
}
