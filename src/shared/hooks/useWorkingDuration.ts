/**
 * useWorkingDuration Hook
 * Tracks the duration of a session while it's in "working" status
 * Uses sent_at timestamp from the latest user message for duration tracking
 * Returns formatted duration string (e.g., "2m 34s")
 */

import { useState, useEffect, useRef } from "react";
import type { SessionStatus } from "@/features/session/types";

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
 * Format duration with tenths always visible.
 * Progressive format — units grow as needed, tenths always trail:
 *   0.0s → 3.2s → 59.9s → 1:23.4 → 1:05:23.4
 */
export function formatDuration(ms: number, showTenths = true): string {
  if (ms < 0) return showTenths ? "0.0s" : "0s";

  const tenths = Math.floor((ms % 1000) / 100);
  const totalSeconds = Math.floor(ms / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);

  if (hours > 0) {
    const base = `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    return showTenths ? `${base}.${tenths}` : base;
  }

  if (minutes > 0) {
    const base = `${minutes}:${String(seconds).padStart(2, "0")}`;
    return showTenths ? `${base}.${tenths}` : base;
  }

  return showTenths ? `${seconds}.${tenths}s` : `${seconds}s`;
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
  const startTimeRef = useRef<number | null>(null);

  const isWorking = status === "working";

  useEffect(() => {
    // Clean up interval and reset ref if not working
    if (!isWorking || !latestMessageSentAt) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      startTimeRef.current = null;
      return;
    }

    const startTime = new Date(latestMessageSentAt).getTime();

    // Guard against invalid timestamps (prevents NaN durations)
    if (isNaN(startTime)) {
      return;
    }

    startTimeRef.current = startTime;

    // Calculate initial duration
    const updateDuration = () => {
      const now = Date.now();
      setDuration(now - startTime);
    };

    // Update immediately
    updateDuration();

    // Update every 100ms for sub-second precision in the timer display
    intervalRef.current = setInterval(updateDuration, 100);

    // Cleanup on unmount or when dependencies change
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [isWorking, latestMessageSentAt]);

  // Return 0 when not working, even if state hasn't cleared yet
  const activeDuration = isWorking && latestMessageSentAt ? duration : 0;

  return {
    duration: activeDuration,
    formattedDuration: activeDuration > 0 ? formatDuration(activeDuration) : "",
    isTracking: isWorking && !!latestMessageSentAt,
  };
}
