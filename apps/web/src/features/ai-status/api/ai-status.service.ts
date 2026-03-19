/**
 * AI Provider Status Service
 *
 * Fetches status from Statuspage.io endpoints with timeout + runtime validation.
 * Each provider has its own `/status.json` endpoint that returns a standard shape.
 */

import {
  PROVIDER_REGISTRY,
  type StatuspageIndicator,
  type StatuspageStatusResponse,
} from "../lib/providers";

// --- Runtime validation ---

const KNOWN_INDICATORS: ReadonlySet<string> = new Set<string>([
  "none",
  "minor",
  "major",
  "critical",
]);

export function toSafeIndicator(value: unknown): StatuspageIndicator {
  return typeof value === "string" && KNOWN_INDICATORS.has(value)
    ? (value as StatuspageIndicator)
    : "none";
}

// --- Fetchers ---

export async function fetchProviderStatus(
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
