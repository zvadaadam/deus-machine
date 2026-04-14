import { useState, useCallback } from "react";

const STORAGE_KEY = "deus:lastOpenInApp";

/** Read last-used app ID directly from localStorage (non-reactive). */
export function getLastOpenInAppId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Write last-used app ID to localStorage. */
function setLastOpenInAppId(appId: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, appId);
  } catch {
    // localStorage unavailable
  }
}

/** Reactive hook for the last-used "Open in" app ID. */
export function useLastOpenInApp(): [string | null, (appId: string) => void] {
  const [lastAppId, setLastAppIdState] = useState<string | null>(() => getLastOpenInAppId());

  const setLastAppId = useCallback((appId: string) => {
    setLastOpenInAppId(appId);
    setLastAppIdState(appId);
  }, []);

  return [lastAppId, setLastAppId];
}
