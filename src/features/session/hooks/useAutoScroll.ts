import { useState, useEffect, useRef, RefObject } from "react";
import type { Message, SessionStatus } from "@/shared/types";

interface UseAutoScrollOptions {
  messages: Message[];
  sessionStatus: SessionStatus;
  messagesContainerRef: RefObject<HTMLDivElement>;
  messagesEndRef: RefObject<HTMLDivElement>;
}

/**
 * Hook to manage auto-scroll behavior and scroll-to-bottom button
 *
 * Features:
 * - Auto-scrolls when new messages arrive
 * - Continuously scrolls during streaming (when content height changes)
 * - Shows "scroll to bottom" button when user scrolls up
 * - Respects user intent (doesn't auto-scroll if user manually scrolled up)
 */
export function useAutoScroll({
  messages,
  sessionStatus,
  messagesContainerRef,
  messagesEndRef,
}: UseAutoScrollOptions) {
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [isUserScrolledUp, setIsUserScrolledUp] = useState(false);
  const lastScrollHeightRef = useRef(0);

  // Check if user is near bottom (within threshold)
  const isNearBottom = (threshold = 100) => {
    const container = messagesContainerRef.current;
    if (!container) return false;

    const { scrollTop, scrollHeight, clientHeight } = container;
    return scrollHeight - scrollTop - clientHeight < threshold;
  };

  // Scroll to bottom function
  const scrollToBottom = (smooth = false) => {
    messagesEndRef.current?.scrollIntoView({
      behavior: smooth ? 'smooth' : 'auto',
      block: 'end'
    });
  };

  // Auto-scroll when new messages arrive (only if user hasn't scrolled up)
  useEffect(() => {
    if (!isUserScrolledUp) {
      scrollToBottom();
    }
  }, [messages.length, isUserScrolledUp]);

  // Track user scroll behavior
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const nearBottom = isNearBottom(100);
      setShowScrollButton(!nearBottom);
      setIsUserScrolledUp(!nearBottom);
    };

    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [messagesContainerRef]);

  // ResizeObserver: Auto-scroll during streaming when content height changes
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const newHeight = entry.target.scrollHeight;
        const oldHeight = lastScrollHeightRef.current;

        // Only auto-scroll if:
        // 1. Content height increased (new content added)
        // 2. User is near bottom (hasn't manually scrolled up)
        // 3. Session is working (streaming in progress)
        if (
          newHeight > oldHeight &&
          !isUserScrolledUp &&
          sessionStatus === 'working'
        ) {
          scrollToBottom(false); // Instant scroll for smooth streaming effect
        }

        lastScrollHeightRef.current = newHeight;
      }
    });

    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, [messagesContainerRef, isUserScrolledUp, sessionStatus]);

  // Manual scroll to bottom (resets user scroll state)
  const handleScrollToBottomClick = () => {
    setIsUserScrolledUp(false);
    scrollToBottom(true);
  };

  return {
    showScrollButton,
    scrollToBottom,
    handleScrollToBottomClick,
  };
}
