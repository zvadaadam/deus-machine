/**
 * useWorkingDuration Hook
 * Tracks the duration of a session while it's in "working" status
 * Returns formatted duration string (e.g., "2m 34s")
 */

import { useState, useEffect, useRef } from 'react';
import type { SessionStatus } from '@/features/session/types';

interface UseWorkingDurationOptions {
  status: SessionStatus | null | undefined;
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
 */
export function useWorkingDuration({
  status,
}: UseWorkingDurationOptions): UseWorkingDurationReturn {
  const [duration, setDuration] = useState(0);
  const startTimeRef = useRef<number | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const isWorking = status === 'working';

  useEffect(() => {
    // Start tracking when status becomes "working"
    if (isWorking && !startTimeRef.current) {
      startTimeRef.current = Date.now();

      // Update duration every second
      intervalRef.current = setInterval(() => {
        if (startTimeRef.current) {
          setDuration(Date.now() - startTimeRef.current);
        }
      }, 1000);
    }

    // Stop tracking when status changes from "working" to something else
    if (!isWorking && startTimeRef.current) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      startTimeRef.current = null;
      setDuration(0);
    }

    // Cleanup on unmount
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [isWorking]);

  return {
    duration,
    formattedDuration: duration > 0 ? formatDuration(duration) : '',
    isTracking: isWorking && startTimeRef.current !== null,
  };
}
