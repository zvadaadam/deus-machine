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

  // Auto-scroll when new messages arrive
  useEffect(() => {
    if (!isUserScrolledUp && messages.length > 0) {
      const lastMessage = messages[messages.length - 1];

      if (lastMessage.role === 'user') {
        // USER message: Scroll to TOP of viewport
        // This pushes previous messages up and out of view, focusing on the new user message
        messagesEndRef.current?.scrollIntoView({
          behavior: 'auto',
          block: 'start',
        });
      } else {
        // ASSISTANT message: Scroll to BOTTOM normally
        // Keeps the full response visible as it streams
        scrollToBottom(false);
      }
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

  // ResizeObserver: Continuous scroll during streaming
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const newHeight = entry.target.scrollHeight;
        const oldHeight = lastScrollHeightRef.current;

        // During streaming, scroll down smoothly as content grows
        // This keeps the streaming message visible and flowing
        if (
          newHeight > oldHeight &&
          !isUserScrolledUp &&
          sessionStatus === 'working'
        ) {
          scrollToBottom(false); // Keep scrolling down during streaming
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
