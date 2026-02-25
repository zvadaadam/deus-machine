/**
 * AI Provider Status Queries
 *
 * Generic Statuspage.io fetcher + TanStack Query hooks.
 * Polls all registered providers in parallel every 5 minutes.
 *
 * Budget: N providers x (1 req / 5 min) ≈ 0.007 req/s for 2 providers.
 * These are external fetches — they don't hit our backend.
 */

import { useQueries } from "@tanstack/react-query";
import { queryKeys } from "@/shared/api/queryKeys";
import {
  PROVIDER_REGISTRY,
  ALL_PROVIDER_IDS,
  getWorstIndicator,
  type StatuspageIndicator,
  type StatuspageStatusResponse,
} from "../lib/providers";

// --- Fetchers ---

async function fetchProviderStatus(
  providerId: string
): Promise<StatuspageStatusResponse> {
  const config = PROVIDER_REGISTRY[providerId];
  if (!config) throw new Error(`Unknown provider: ${providerId}`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(`${config.statusPageBaseUrl}/status.json`, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) throw new Error(`Status page returned ${res.status}`);
    return res.json();
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

// --- Hooks ---

export interface ProviderStatusEntry {
  providerId: string;
  indicator: StatuspageIndicator;
  description: string;
  isLoading: boolean;
  isError: boolean;
}

/**
 * Poll all registered providers in parallel.
 *
 * Uses useQueries (one query per provider) so they cache independently.
 * If one provider's fetch fails, the other's cached data stays valid.
 * Failed fetches are treated as "none" to avoid false alarms.
 */
export function useProviderStatuses() {
  const queries = useQueries({
    queries: ALL_PROVIDER_IDS.map((providerId) => ({
      queryKey: queryKeys.providerStatus.detail(providerId),
      queryFn: () => fetchProviderStatus(providerId),
      refetchInterval: 5 * 60 * 1000,
      staleTime: 4 * 60 * 1000,
      // refetchOnWindowFocus intentionally omitted — globally disabled in Tauri
      // due to WKWebView treating input focus as window focus (causes typing lag).
      // The 5-min refetchInterval is sufficient for status polling.
      retry: 1,
      retryDelay: 10_000,
    })),
  });

  const statuses: ProviderStatusEntry[] = queries.map((q, i) => ({
    providerId: ALL_PROVIDER_IDS[i],
    indicator: (q.data?.status.indicator ?? "none") as StatuspageIndicator,
    description: q.data?.status.description ?? "",
    isLoading: q.isLoading,
    isError: q.isError,
  }));

  const worst = getWorstIndicator(
    statuses.map((s) => ({ providerId: s.providerId, indicator: s.indicator }))
  );

  return { statuses, worst };
}
