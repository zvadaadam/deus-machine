/**
 * useAutoScroll Hook (Simplified)
 *
 * Manages chat auto-scroll behavior with minimal complexity:
 * - Auto-scrolls to bottom when new messages arrive
 * - Shows "scroll to bottom" button when user scrolls up
 * - Respects user intent (doesn't auto-scroll if user manually scrolled up)
 *
 * SIMPLIFIED from 191 lines → 85 lines
 * - Removed ResizeObserver, throttling, complex user intent detection
 * - Single behavior: scroll to bottom on new messages unless user scrolled up
 * - Much easier to understand and debug
 */

import { useState, useEffect, useCallback, RefObject } from "react";
import type { Message } from "@/shared/types";

interface UseAutoScrollOptions {
  messages: Message[];
  messagesContainerRef: RefObject<HTMLDivElement>;
  messagesEndRef: RefObject<HTMLDivElement>;
  scrollThreshold?: number; // Distance from bottom to consider "at bottom" (default: 100)
}

export function useAutoScroll({
  messages,
  messagesContainerRef,
  messagesEndRef,
  scrollThreshold = 100,
}: UseAutoScrollOptions) {
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [userScrolledUp, setUserScrolledUp] = useState(false);

  // Check if user is near bottom
  const isNearBottom = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return true;

    const { scrollTop, scrollHeight, clientHeight } = container;
    return scrollHeight - scrollTop - clientHeight < scrollThreshold;
  }, [messagesContainerRef, scrollThreshold]);

  // Scroll to bottom function
  const scrollToBottom = useCallback(
    (smooth = false) => {
      messagesEndRef.current?.scrollIntoView({
        behavior: smooth ? "smooth" : "auto",
        block: "end",
      });
    },
    [messagesEndRef]
  );

  // Auto-scroll when new messages arrive (if user hasn't scrolled up)
  useEffect(() => {
    if (!userScrolledUp && messages.length > 0) {
      // Small delay to ensure DOM has updated
      requestAnimationFrame(() => {
        scrollToBottom(false);
      });
    }
  }, [messages.length, userScrolledUp, scrollToBottom]);

  // Track user scroll behavior
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const nearBottom = isNearBottom();
      setShowScrollButton(!nearBottom);
      setUserScrolledUp(!nearBottom);
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [messagesContainerRef, isNearBottom]);

  // Manual scroll to bottom (resets user scroll state)
  const handleScrollToBottomClick = useCallback(() => {
    setUserScrolledUp(false);
    const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    scrollToBottom(!prefersReduced);
  }, [scrollToBottom]);

  return {
    showScrollButton,
    scrollToBottom,
    handleScrollToBottomClick,
  };
}
