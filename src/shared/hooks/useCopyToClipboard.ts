/**
 * useCopyToClipboard Hook
 *
 * Centralized hook for copy-to-clipboard functionality with visual feedback.
 * Manages copied state, timer cleanup, and error handling.
 *
 * Usage:
 *   const { copy, copied } = useCopyToClipboard();
 *   <button onClick={() => copy(text)}>
 *     {copied ? 'Copied!' : 'Copy'}
 *   </button>
 */

import { useState, useEffect, useRef, useCallback } from 'react';

interface UseCopyToClipboardOptions {
  resetDelay?: number; // Milliseconds before resetting "copied" state (default: 2000)
}

interface UseCopyToClipboardReturn {
  copy: (text: string) => Promise<boolean>;
  copied: boolean;
  error: Error | null;
}

export function useCopyToClipboard(
  options: UseCopyToClipboardOptions = {}
): UseCopyToClipboardReturn {
  const { resetDelay = 2000 } = options;
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const timerRef = useRef<number | null>(null);

  const copy = useCallback(async (text: string): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setError(null);

      // Clear existing timer before setting new one
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }

      // Reset "copied" state after delay
      timerRef.current = window.setTimeout(() => {
        setCopied(false);
      }, resetDelay);

      return true;
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to copy to clipboard');
      setError(error);
      console.error('Failed to copy:', error);
      return false;
    }
  }, [resetDelay]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  return { copy, copied, error };
}
