/**
 * useWorkingDuration Hook
 * Tracks the duration of a session while it's in "working" status
 * Uses sent_at timestamp from the latest user message for duration tracking
 * Returns formatted duration string (e.g., "2m 34s")
 */

import { useState, useEffect, useRef } from 'react';
import type { SessionStatus } from '@/features/session/types';

interface UseWorkingDurationOptions {
  status: SessionStatus | null | undefined;
  latestMessageSentAt?: string | null; // ISO timestamp from latest user message's sent_at
}

interface UseWorkingDurationReturn {
  duration: number; // Duration in milliseconds
  formattedDuration: string; // Formatted string like "2m 34s"
  isTracking: boolean; // Whether we're currently tracking
}

/**
 * Format duration in milliseconds to human-readable string
 * Examples: "5s", "1m 23s", "1h 5m", "2h 34m"
 */
export function formatDuration(ms: number): string {
  // Guard against negative durations (clock skew, bad data)
  if (ms < 0) return '0s';

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  }

  if (minutes > 0) {
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  }

  return `${seconds}s`;
}

/**
 * Hook to track working duration
 * Uses sent_at from latest user message for accurate, persistent duration tracking
 */
export function useWorkingDuration({
  status,
  latestMessageSentAt,
}: UseWorkingDurationOptions): UseWorkingDurationReturn {
  const [duration, setDuration] = useState(0);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const isWorking = status === 'working';

  useEffect(() => {
    // Calculate duration if working and have start timestamp
    if (isWorking && latestMessageSentAt) {
      const startTime = new Date(latestMessageSentAt).getTime();

      // Guard against invalid timestamps (prevents NaN durations)
      if (isNaN(startTime)) {
        setDuration(0);
        return;
      }

      // Calculate initial duration
      const updateDuration = () => {
        const now = Date.now();
        setDuration(now - startTime);
      };

      // Update immediately
      updateDuration();

      // Update duration every second
      intervalRef.current = setInterval(updateDuration, 1000);
    } else {
      // Clear duration when not working
      setDuration(0);
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }

    // Cleanup on unmount or when dependencies change
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [isWorking, latestMessageSentAt]);

  return {
    duration,
    formattedDuration: duration > 0 ? formatDuration(duration) : '',
    isTracking: isWorking && !!latestMessageSentAt,
  };
}
