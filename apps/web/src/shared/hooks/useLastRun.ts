import { useState, useCallback } from "react";

const STORAGE_KEY = "deus:lastRun";

/** Read last-run task name directly from localStorage (non-reactive). */
export function getLastRunName(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Write last-run task name to localStorage. */
export function setLastRunName(taskName: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, taskName);
  } catch {
    // localStorage unavailable
  }
}

/** Reactive hook for the last-run task name. */
export function useLastRun(): [string | null, (taskName: string) => void] {
  const [lastRun, setLastRunState] = useState<string | null>(() => getLastRunName());

  const setLastRun = useCallback((taskName: string) => {
    setLastRunName(taskName);
    setLastRunState(taskName);
  }, []);

  return [lastRun, setLastRun];
}
