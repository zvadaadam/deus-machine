import { useCallback, useEffect, useState } from "react";

interface ClipboardOptions {
  resetDelay?: number;
  onError?: (error: unknown) => void;
}

export function useCopyToClipboard({ resetDelay = 2000, onError }: ClipboardOptions = {}) {
  const [recentCopies, setRecentCopies] = useState(0);

  // A second success restarts the acknowledgement, even while the check is visible.
  useEffect(() => {
    if (!recentCopies) return;
    const timer = window.setTimeout(() => setRecentCopies(0), resetDelay);
    return () => window.clearTimeout(timer);
  }, [recentCopies, resetDelay]);

  const copy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        setRecentCopies((count) => count + 1);
        return true;
      } catch (error) {
        console.error("Failed to copy:", error);
        onError?.(error);
        return false;
      }
    },
    [onError]
  );

  return { copy, copied: recentCopies > 0 };
}
