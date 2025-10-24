/**
 * useWorkingDuration Hook
 * Tracks the duration of a session while it's in "working" status
 * Uses working_started_at timestamp from backend for persistence
 * Returns formatted duration string (e.g., "2m 34s")
 */

import { useState, useEffect, useRef } from 'react';
import type { SessionStatus } from '@/features/session/types';

interface UseWorkingDurationOptions {
  status: SessionStatus | null | undefined;
  workingStartedAt?: string | null; // ISO timestamp from backend
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
 * Uses backend timestamp for accurate, persistent duration tracking
 */
export function useWorkingDuration({
  status,
  workingStartedAt,
}: UseWorkingDurationOptions): UseWorkingDurationReturn {
  const [duration, setDuration] = useState(0);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const isWorking = status === 'working';

  useEffect(() => {
    // Calculate duration if working and have start timestamp
    if (isWorking && workingStartedAt) {
      const startTime = new Date(workingStartedAt).getTime();

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
  }, [isWorking, workingStartedAt]);

  return {
    duration,
    formattedDuration: duration > 0 ? formatDuration(duration) : '',
    isTracking: isWorking && !!workingStartedAt,
  };
}
