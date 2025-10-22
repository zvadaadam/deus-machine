import { useState, useEffect, useRef, RefObject } from "react";
import type { Message, SessionStatus } from "@/shared/types";

interface UseAutoScrollOptions {
  messages: Message[];
  sessionStatus: SessionStatus;
  messagesContainerRef: RefObject<HTMLDivElement>;
  messagesEndRef: RefObject<HTMLDivElement>;
  // Configuration options
  scrollThreshold?: number; // Distance from bottom to consider "at bottom" (default: 100)
  inputHeightBuffer?: number; // Buffer for message input height (default: 80)
  smoothScrollUser?: boolean; // Use smooth scroll for user messages (default: false)
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
  scrollThreshold = 100,
  inputHeightBuffer = 80,
  smoothScrollUser = false,
}: UseAutoScrollOptions) {
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [isUserScrolledUp, setIsUserScrolledUp] = useState(false);
  const lastScrollHeightRef = useRef(0);
  const lastMessageCountRef = useRef(0);
  const isAutoScrollingRef = useRef(false); // Track if we're auto-scrolling

  // Check if user is near bottom (within threshold)
  const isNearBottom = (threshold = scrollThreshold) => {
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
    // Only auto-scroll if a NEW message was added (not on initial mount)
    if (messages.length === 0 || messages.length === lastMessageCountRef.current) {
      lastMessageCountRef.current = messages.length;
      return;
    }

    const lastMessage = messages[messages.length - 1];

    console.log('[useAutoScroll] New message:', {
      role: lastMessage.role,
      messageCount: messages.length,
      isUserScrolledUp
    });

    if (!isUserScrolledUp) {
      isAutoScrollingRef.current = true; // Mark that we're auto-scrolling

      if (lastMessage.role === 'user') {
        // USER message: Scroll to TOP of viewport
        console.log('[useAutoScroll] Scrolling user message to TOP');
        setTimeout(() => {
          messagesEndRef.current?.scrollIntoView({
            behavior: smoothScrollUser ? 'smooth' : 'auto',
            block: 'start',
          });
          // Reset flag after scroll completes
          setTimeout(() => {
            isAutoScrollingRef.current = false;
          }, 100);
        }, 0);
      } else {
        // ASSISTANT message: Scroll to BOTTOM normally
        console.log('[useAutoScroll] Scrolling assistant message to BOTTOM');
        setTimeout(() => {
          scrollToBottom(false);
          // Reset flag after scroll completes
          setTimeout(() => {
            isAutoScrollingRef.current = false;
          }, 100);
        }, 0);
      }
    }

    lastMessageCountRef.current = messages.length;
  }, [messages.length, isUserScrolledUp, smoothScrollUser]);

  // Track user scroll behavior
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      // Don't update state if we're auto-scrolling
      if (isAutoScrollingRef.current) {
        console.log('[useAutoScroll] Ignoring scroll event (auto-scrolling)');
        return;
      }

      const nearBottom = isNearBottom();
      console.log('[useAutoScroll] User scroll detected, nearBottom:', nearBottom);
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
          // Add buffer to account for message input height
          const contentBottom = newHeight;
          const isContentHidden = contentBottom > viewportBottom + inputHeightBuffer;

          console.log('[useAutoScroll] ResizeObserver:', {
            newHeight,
            oldHeight,
            viewportBottom,
            contentBottom,
            isContentHidden,
            sessionStatus
          });

          // Only scroll if content would be cut off
          if (isContentHidden) {
            console.log('[useAutoScroll] Content hidden, scrolling to bottom');
            isAutoScrollingRef.current = true;
            scrollToBottom(false); // Scroll to reveal hidden content
            setTimeout(() => {
              isAutoScrollingRef.current = false;
            }, 100);
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
