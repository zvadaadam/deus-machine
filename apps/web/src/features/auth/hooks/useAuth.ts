// Remote access auth state management.
// Checks if the current browser context requires token auth (non-Electron, non-localhost).
// Stores and validates device tokens in localStorage.

import { useState, useEffect, useCallback } from "react";
import { isElectronEnv } from "@/platform/electron";

const TOKEN_KEY = "opendevs_device_token";
const DEVICE_NAME_KEY = "opendevs_device_name";

/** Whether this browser session needs remote auth (non-Electron + non-localhost). */
export function needsRemoteAuth(): boolean {
  if (isElectronEnv) return false;
  const host = window.location.hostname;
  return host !== "localhost" && host !== "127.0.0.1" && host !== "::1";
}

/** Get the stored device token (or null). */
export function getStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/** Store a device token after successful pairing. */
export function storeToken(token: string, deviceName?: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  if (deviceName) localStorage.setItem(DEVICE_NAME_KEY, deviceName);
}

/** Clear stored token (logout). */
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(DEVICE_NAME_KEY);
}

export interface AuthState {
  /** Whether auth check is still in progress. */
  isLoading: boolean;
  /** Whether the user is authenticated (or auth not required). */
  isAuthenticated: boolean;
  /** Set after successful pairing — triggers re-render. */
  onPaired: (token: string, deviceName?: string) => void;
}

/**
 * Hook that manages remote auth state.
 * - Electron or localhost: always authenticated (no token needed).
 * - Remote browser: checks localStorage for a valid token.
 */
export function useAuth(): AuthState {
  const requiresAuth = needsRemoteAuth();
  const [isAuthenticated, setIsAuthenticated] = useState(!requiresAuth);
  const [isLoading, setIsLoading] = useState(requiresAuth);

  // Initialize auth state based on requiresAuth flag
  // No auth needed means we're immediately authenticated
  if (isLoading && !requiresAuth) {
    setIsAuthenticated(true);
    setIsLoading(false);
  }

  useEffect(() => {
    if (!requiresAuth) {
      return;
    }

    // Check if we have a stored token
    const token = getStoredToken();
    if (token) {
      // Token exists — trust it (backend will reject invalid tokens at request time)
      setIsAuthenticated(true);
    }
    setIsLoading(false);
  }, [requiresAuth]);

  const onPaired = useCallback((token: string, deviceName?: string) => {
    storeToken(token, deviceName);
    setIsAuthenticated(true);
  }, []);

  return { isLoading, isAuthenticated, onPaired };
}
