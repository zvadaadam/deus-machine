// Remote access auth state management.
// Checks if the current browser context requires token auth (non-Electron, non-localhost).
// Stores and validates device tokens in localStorage.
//
// The signOut() function is the canonical way to log out from any module.
// It clears localStorage AND notifies the useAuth() hook via a module-level
// callback so React state updates immediately (e.g., after an auth_failed WS frame).

import { useState, useEffect, useCallback } from "react";
import { capabilities } from "@/platform/capabilities";

const TOKEN_KEY = "opendevs_device_token";
const DEVICE_NAME_KEY = "opendevs_device_name";

/** Whether this browser session needs remote auth (non-Electron + non-localhost). */
export function needsRemoteAuth(): boolean {
  if (capabilities.ipcInvoke) return false;
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

// Module-level callback set by the active useAuth() hook instance.
// signOut() invokes this to push React state updates when called from
// non-React code (e.g., the WS client's auth_failed handler).
let _onSignOut: (() => void) | null = null;

/**
 * Sign out: clears stored token AND notifies the active useAuth() hook
 * so React re-renders immediately. Safe to call from anywhere (WS handlers,
 * event listeners, non-React code).
 */
export function signOut(): void {
  clearToken();
  _onSignOut?.();
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

  // Initialize state synchronously — no effect needed for initial check
  const [isAuthenticated, setIsAuthenticated] = useState(() => {
    if (!requiresAuth) return true;
    return !!getStoredToken();
  });
  const [isLoading] = useState(false);

  // Register the module-level signOut callback so external callers
  // (e.g., the WS client on auth_failed) can invalidate React state.
  useEffect(() => {
    if (!requiresAuth) return;

    _onSignOut = () => setIsAuthenticated(false);
    return () => {
      _onSignOut = null;
    };
  }, [requiresAuth]);

  const onPaired = useCallback((token: string, deviceName?: string) => {
    storeToken(token, deviceName);
    setIsAuthenticated(true);
  }, []);

  return { isLoading, isAuthenticated, onPaired };
}
