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
import type { Message } from "@/shared/types";

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
  messages: Message[];
  messagesContainerRef: RefObject<HTMLDivElement>;
  /** Incremented by the UI when the human clicks Send. Triggers resume + jump to bottom. */
  userSendCount: number;
}

export function useAutoScroll({
  messages,
  messagesContainerRef,
  userSendCount,
}: UseAutoScrollOptions) {
  const [showScrollButton, setShowScrollButton] = useState(false);

  const isPausedRef = useRef(false);
  const pausedAtRef = useRef(0);
  const chaseRafRef = useRef<number | null>(null);

  const prevMessageCountRef = useRef(messages.length);
  const prevLastMessageIdRef = useRef<string | null>(
    messages.length > 0 ? messages[messages.length - 1].id : null
  );

  // ── Chase loop ──────────────────────────────────────────────────────

  const pauseFromLoop = useCallback(() => {
    log("PAUSE (from loop) — user scroll detected");
    isPausedRef.current = true;
    pausedAtRef.current = Date.now();
    setShowScrollButton(true);
  }, []);

  const startChase = useCallback(() => {
    if (chaseRafRef.current !== null) {
      log("startChase: already running, skip");
      return;
    }

    log("startChase: starting new chase loop");

    let idleFrames = 0;
    let lastWrittenScrollTop = -1;
    let graceFrames = GRACE_FRAMES;
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
      const target = scrollHeight - clientHeight;
      const distance = target - scrollTop;

      // Log every 30th tick to avoid spam, but always log key events
      const shouldLogTick = tickCount % 30 === 1;

      // ── In-loop pause detection ──────────────────────────────────
      if (graceFrames > 0) {
        graceFrames--;
        if (shouldLogTick) {
          log(
            `tick ${tickCount}: grace=${graceFrames}, scrollTop=${Math.round(scrollTop)}, lastWritten=${Math.round(lastWrittenScrollTop)}, distance=${Math.round(distance)}`
          );
        }
      } else if (lastWrittenScrollTop >= 0) {
        const wentBackward = scrollTop < lastWrittenScrollTop - 2;
        const nearBottom = scrollTop + clientHeight >= scrollHeight - 5;

        if (wentBackward) {
          log(
            `tick ${tickCount}: BACKWARD DETECTED — scrollTop=${Math.round(scrollTop)}, lastWritten=${Math.round(lastWrittenScrollTop)}, delta=${Math.round(scrollTop - lastWrittenScrollTop)}, nearBottom=${nearBottom}`
          );
          if (!nearBottom) {
            log(`tick ${tickCount}: → PAUSING (not near bottom)`);
            pauseFromLoop();
            chaseRafRef.current = null;
            return;
          } else {
            log(`tick ${tickCount}: → ignored (near bottom, likely content shrink)`);
          }
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
          chaseRafRef.current = null;
          return;
        }
      } else {
        idleFrames = 0;
      }

      lastWrittenScrollTop = el.scrollTop;
      chaseRafRef.current = requestAnimationFrame(tick);
    };

    chaseRafRef.current = requestAnimationFrame(tick);
  }, [messagesContainerRef, pauseFromLoop]);

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
    startChase();
  }, [startChase, stopChase]);

  // ── Scroll to bottom ───────────────────────────────────────────────

  const scrollToBottom = useCallback(() => {
    log("scrollToBottom clicked");
    resume();
  }, [resume]);

  const syncGeometry = useCallback(() => {
    log("syncGeometry: pausing chase for 2 frames");
    stopChase();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!isPausedRef.current) startChase();
      });
    });
  }, [stopChase, startChase]);

  // ── Scroll listener: pause detection + re-engagement ────────────────
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      if (!isPausedRef.current) {
        // Chase loop may have self-stopped (idle at bottom). If the user
        // then scrolls away from bottom, we must pause NOW — otherwise
        // the next message arrival will restart the chase and yank them
        // back to the bottom. The in-loop backward detection only works
        // while the loop is running; this covers the stopped-loop gap.
        if (chaseRafRef.current === null && !isAtBottom(container)) {
          log("scroll listener: chase idle + scrolled away → PAUSE");
          isPausedRef.current = true;
          pausedAtRef.current = Date.now();
          setShowScrollButton(true);
        }
        return;
      }

      // Already paused — check for re-engagement (scroll back to bottom)
      const elapsed = Date.now() - pausedAtRef.current;
      if (elapsed >= PAUSE_COOLDOWN_MS && isAtBottom(container)) {
        log(`scroll re-engagement: at bottom after ${elapsed}ms cooldown`);
        resume();
      }
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [messagesContainerRef, resume]);

  // ── Start chase when content is present ─────────────────────────────
  const contentReady = messages.length > 0;
  useEffect(() => {
    if (!contentReady || isPausedRef.current) return;
    log("contentReady effect: starting chase");
    startChase();
    return () => stopChase();
  }, [contentReady, startChase, stopChase]);

  // ── Human send → resume ────────────────────────────────────────────
  // Triggered by SessionPanel incrementing userSendCount when the human
  // actually clicks Send. NOT triggered by sidecar tool_results (which
  // also have role="user" in the Claude SDK format).
  const prevSendCountRef = useRef(userSendCount);
  useEffect(() => {
    if (userSendCount === prevSendCountRef.current) return;
    prevSendCountRef.current = userSendCount;

    log("userSendCount changed — human sent a message");
    const container = messagesContainerRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
    resume();
  }, [userSendCount, messagesContainerRef, resume]);

  // ── New message handling ────────────────────────────────────────────
  // Never resumes — only restarts chase when not paused.
  // Resume is handled exclusively by: human send, scroll-to-bottom click,
  // or scroll re-engagement (scrolling back to bottom).
  useEffect(() => {
    const count = messages.length;
    const prevCount = prevMessageCountRef.current;
    const lastId = count > 0 ? messages[count - 1].id : null;
    const prevLastId = prevLastMessageIdRef.current;

    prevMessageCountRef.current = count;
    prevLastMessageIdRef.current = lastId;

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
  }, [messages, startChase, stopChase]);

  // ── Cleanup ─────────────────────────────────────────────────────────
  useEffect(() => () => stopChase(), [stopChase]);

  return {
    showScrollButton,
    handleScrollToBottomClick: scrollToBottom,
    syncGeometry,
  };
}
