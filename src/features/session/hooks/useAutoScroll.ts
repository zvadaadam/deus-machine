import { useState, useEffect, useRef, RefObject } from "react";
import type { Message, SessionStatus } from "@/shared/types";

interface UseAutoScrollOptions {
  messages: Message[];
  sessionStatus: SessionStatus;
  messagesContainerRef: RefObject<HTMLDivElement>;
  messagesEndRef: RefObject<HTMLDivElement>; // Empty div at end of messages
  lastMessageRef: RefObject<HTMLDivElement>; // Last message element
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
  lastMessageRef,
  scrollThreshold = 100,
  inputHeightBuffer = 80,
  smoothScrollUser = false,
}: UseAutoScrollOptions) {
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [isUserScrolledUp, setIsUserScrolledUp] = useState(false);
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
    const container = messagesContainerRef.current;

    if (!isUserScrolledUp && container) {
      isAutoScrollingRef.current = true;

      if (lastMessage.role === 'user') {
        // USER message: Scroll marker to TOP of viewport
        requestAnimationFrame(() => {
          const marker = lastMessageRef.current;
          if (marker) {
            // Get marker position relative to container
            const markerTop = marker.offsetTop;
            // Scroll container so marker is at the top
            const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            container.scrollTo({
              top: Math.max(0, markerTop),
              behavior: smoothScrollUser && !prefersReduced ? 'smooth' : 'auto',
            });

            if (import.meta.env.DEV) {
              console.log('[useAutoScroll] User message scrolled to top:', markerTop);
            }
          } else {
            if (import.meta.env.DEV) {
              console.warn('[useAutoScroll] lastMessageRef is null!');
            }
          }

          setTimeout(() => {
            isAutoScrollingRef.current = false;
          }, 100);
        });
      } else {
        // ASSISTANT message: Scroll to BOTTOM
        requestAnimationFrame(() => {
          scrollToBottom(false);

          setTimeout(() => {
            isAutoScrollingRef.current = false;
          }, 100);
        });
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
      if (isAutoScrollingRef.current) return;

      const nearBottom = isNearBottom();
      setShowScrollButton(!nearBottom);
      setIsUserScrolledUp(!nearBottom);
    };

    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [messagesContainerRef]);

  // ResizeObserver: Auto-scroll during streaming (when content grows)
  useEffect(() => {
    const container = messagesContainerRef.current;
    const target = lastMessageRef.current ?? messagesEndRef.current;
    if (!container || !target) return;

    const resizeObserver = new ResizeObserver(() => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      const viewportBottom = scrollTop + clientHeight;
      const contentBottom = scrollHeight;
      const isContentHidden = contentBottom > viewportBottom + inputHeightBuffer;

      // Only auto-scroll if:
      // 1. In working session (streaming)
      // 2. User hasn't scrolled up
      // 3. Content would be hidden below viewport
      if (sessionStatus === 'working' && !isUserScrolledUp && isContentHidden) {
        isAutoScrollingRef.current = true;
        scrollToBottom(false);
        setTimeout(() => {
          isAutoScrollingRef.current = false;
        }, 50);
      }
    });

    resizeObserver.observe(target);
    return () => resizeObserver.disconnect();
  }, [messagesContainerRef, messagesEndRef, lastMessageRef, isUserScrolledUp, sessionStatus, inputHeightBuffer]);

  // Manual scroll to bottom (resets user scroll state)
  const handleScrollToBottomClick = () => {
    setIsUserScrolledUp(false);
    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    scrollToBottom(!prefersReduced);
  };

  return {
    showScrollButton,
    scrollToBottom,
    handleScrollToBottomClick,
  };
}
