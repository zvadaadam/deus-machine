/**
 * TanStack Query Configuration
 * Optimized for real-time IDE with polling and WebSocket updates
 */

import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Cache data for 5 minutes by default (reduce unnecessary refetches)
      staleTime: 5 * 60 * 1000,

      // Keep unused data in cache for 5 minutes
      gcTime: 5 * 60 * 1000,

      // Retry failed requests (exponential backoff)
      retry: 2,
      retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),

      // ❌ Don't refetch on window focus (causes refetch on every input focus)
      refetchOnWindowFocus: false,

      // Refetch on mount only if data is stale (reduces unnecessary requests)
      refetchOnMount: 'stale',

      // Don't refetch on reconnect (we handle this with polling)
      refetchOnReconnect: false,

      // Network mode (always fetch, even offline for local backend)
      networkMode: 'always',
    },
    mutations: {
      // Retry mutations once on failure
      retry: 1,
      networkMode: 'always',
    },
  },
});
