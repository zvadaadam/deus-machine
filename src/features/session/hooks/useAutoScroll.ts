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
 * - USER messages: Scroll to top of viewport (push old messages up)
 * - ASSISTANT messages: Smart overflow detection
 *   - If there's visible space below → NO scroll (messages appear naturally)
 *   - If content would be hidden → AUTO scroll (reveal new content)
 * - Shows "scroll to bottom" button when user scrolls up
 * - Respects user intent (doesn't auto-scroll if user manually scrolled up)
 *
 * UX Benefits:
 * - Reduces unnecessary scrolling when viewport has space
 * - User sees their question + answer simultaneously
 * - Less jarring, more natural content flow
 * - Only scrolls when content would actually be cut off
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

  // ResizeObserver: Smart scroll during streaming
  // Only scrolls if content would overflow viewport (be hidden)
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const newHeight = entry.target.scrollHeight;
        const oldHeight = lastScrollHeightRef.current;

        // Only proceed if content grew and we're in a working session
        if (
          newHeight > oldHeight &&
          !isUserScrolledUp &&
          sessionStatus === 'working'
        ) {
          // Calculate visible boundaries
          const { scrollTop, clientHeight } = container;
          const viewportBottom = scrollTop + clientHeight;

          // Check if new content would be hidden below viewport
          // Add small buffer (50px) to account for message input height
          const contentBottom = newHeight;
          const isContentHidden = contentBottom > viewportBottom + 50;

          // Only scroll if content would be cut off
          if (isContentHidden) {
            scrollToBottom(false); // Scroll to reveal hidden content
          }
          // Otherwise, let content appear naturally without scrolling
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
