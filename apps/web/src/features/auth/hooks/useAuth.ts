// Remote access auth state management.
// Checks if the current browser context requires token auth (non-Electron, non-localhost).
// Stores and validates device tokens in localStorage.
//
// The signOut() function is the canonical way to log out from any module.
// It clears localStorage AND dispatches a CustomEvent so any useAuth() listener
// updates React state immediately (e.g., after an auth_failed WS frame).

import { useState, useEffect, useCallback } from "react";
import { capabilities } from "@/platform/capabilities";

const TOKEN_KEY = "opendevs_device_token";
const DEVICE_NAME_KEY = "opendevs_device_name";
const SIGNOUT_EVENT = "opendevs:signout";

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

/**
 * Sign out: clears stored token AND dispatches a CustomEvent so any
 * useAuth() listener re-renders immediately. Safe to call from anywhere
 * (WS handlers, event listeners, non-React code). Supports multiple
 * listeners without mutable module state.
 */
export function signOut(): void {
  clearToken();
  window.dispatchEvent(new CustomEvent(SIGNOUT_EVENT));
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

  // Listen for signOut events dispatched from any context (WS handlers, etc.)
  useEffect(() => {
    if (!requiresAuth) return;

    const handler = () => setIsAuthenticated(false);
    window.addEventListener(SIGNOUT_EVENT, handler);
    return () => {
      window.removeEventListener(SIGNOUT_EVENT, handler);
    };
  }, [requiresAuth]);

  const onPaired = useCallback((token: string, deviceName?: string) => {
    storeToken(token, deviceName);
    setIsAuthenticated(true);
  }, []);

  return { isLoading, isAuthenticated, onPaired };
}
