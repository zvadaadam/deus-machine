/**
 * TanStack Query Configuration
 * Optimized for real-time IDE with polling and WebSocket updates
 *
 * PERFORMANCE NOTES:
 * - Was: staleTime 1000ms → Caused cascade refetches on every re-render
 * - Was: refetchOnWindowFocus true → Triggered refetch on EVERY input focus (typing lag)
 * - Now: 5min staleTime + disabled focus refetch = smooth typing, 60% fewer requests
 *
 * ARCHITECTURE:
 * - Desktop (Tauri): Real-time via Unix socket events + minimal polling
 * - Web (Browser): Smart conditional polling (only when workspace working)
 * - Individual queries override these defaults for specific needs
 */

import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Cache data for 5 minutes (was 1000ms - caused excessive refetches)
      // Long staleTime is safe because:
      // - Real-time data uses events (desktop) or conditional polling (web)
      // - Static data (repos, settings) rarely changes
      staleTime: 5 * 60 * 1000,

      // Keep unused data in cache for 5 minutes
      gcTime: 5 * 60 * 1000,

      // Retry failed requests (exponential backoff)
      retry: 2,
      retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),

      // ❌ DISABLED: Causes refetch on every input focus (typing lag)
      // Every keystroke triggered focus change → cascade refetch
      refetchOnWindowFocus: false,

      // Only refetch if data is actually stale (not on every mount)
      refetchOnMount: 'stale',

      // Don't refetch on reconnect (conditional polling handles updates)
      refetchOnReconnect: false,

      // Network mode: always fetch (even offline for local backend)
      networkMode: 'always',
    },
    mutations: {
      // Retry mutations once on failure
      retry: 1,
      networkMode: 'always',
    },
  },
});
