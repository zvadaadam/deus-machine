import { useState, useEffect, RefObject } from "react";
import type { Message, SessionStatus } from "@/shared/types";

interface UseAutoScrollOptions {
  messages: Message[];
  sessionStatus: SessionStatus;
  messagesContainerRef: RefObject<HTMLDivElement>;
  messagesEndRef: RefObject<HTMLDivElement>;
}

/**
 * Hook to manage auto-scroll behavior and scroll-to-bottom button
 */
export function useAutoScroll({
  messages,
  sessionStatus,
  messagesContainerRef,
  messagesEndRef,
}: UseAutoScrollOptions) {
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true);

  // Auto-scroll when messages change or session status changes
  useEffect(() => {
    if (shouldAutoScroll) {
      scrollToBottom();
      setShouldAutoScroll(false);
    }
  }, [messages, sessionStatus, shouldAutoScroll]);

  // Handle scroll detection for "scroll to bottom" button
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      const isNearBottom = scrollHeight - scrollTop - clientHeight < 100;
      setShowScrollButton(!isNearBottom);
    };

    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [messagesContainerRef]);

  function scrollToBottom(smooth = false) {
    messagesEndRef.current?.scrollIntoView({
      behavior: smooth ? 'smooth' : 'auto',
      block: 'end'
    });
  }

  function handleScrollToBottomClick() {
    setShouldAutoScroll(true);
    scrollToBottom(true);
  }

  return {
    showScrollButton,
    scrollToBottom,
    handleScrollToBottomClick,
  };
}
