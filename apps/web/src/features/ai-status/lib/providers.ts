/**
 * AI Provider Status Registry
 *
 * Extensible registry for monitoring AI provider health via Statuspage.io APIs.
 * Adding a new provider: add one entry to PROVIDER_REGISTRY (~5 lines).
 * Both Claude and OpenAI use identical Statuspage.io API format.
 */

import { match } from "ts-pattern";

// --- Statuspage.io API types ---

export type StatuspageIndicator = "none" | "minor" | "major" | "critical";

export type ComponentStatus =
  | "operational"
  | "degraded_performance"
  | "partial_outage"
  | "major_outage"
  | "under_maintenance";

export interface StatuspageStatusResponse {
  status: {
    indicator: StatuspageIndicator;
    description: string;
  };
  page: {
    name: string;
    url: string;
  };
}

// --- Provider registry ---

export interface ProviderConfig {
  name: string;
  statusPageBaseUrl: string;
  statusPageUrl: string;
  relevantComponents: string[];
}

export const PROVIDER_REGISTRY: Record<string, ProviderConfig> = {
  claude: {
    name: "Claude",
    statusPageBaseUrl: "https://status.claude.com/api/v2",
    statusPageUrl: "https://status.claude.com",
    relevantComponents: ["Claude Code", "Claude API"],
  },
  openai: {
    name: "OpenAI",
    statusPageBaseUrl: "https://status.openai.com/api/v2",
    statusPageUrl: "https://status.openai.com",
    relevantComponents: ["Codex", "Chat Completions", "Responses"],
  },
  // Future providers — just add entries:
  // groq: {
  //   name: "Groq",
  //   statusPageBaseUrl: "https://groqstatus.com/api/v2",
  //   statusPageUrl: "https://groqstatus.com",
  //   relevantComponents: ["API"],
  // },
  // deepseek: {
  //   name: "DeepSeek",
  //   statusPageBaseUrl: "https://status.deepseek.com/api/v2",
  //   statusPageUrl: "https://status.deepseek.com",
  //   relevantComponents: ["API Service"],
  // },
};

export const ALL_PROVIDER_IDS = Object.keys(PROVIDER_REGISTRY);

// --- Visual config ---

export interface IndicatorVisuals {
  dotClass: string;
  label: string;
  priority: number;
}

export function getIndicatorVisuals(indicator: StatuspageIndicator): IndicatorVisuals {
  return match(indicator)
    .with("none", () => ({
      dotClass: "bg-accent-green",
      label: "Operational",
      priority: 0,
    }))
    .with("minor", () => ({
      dotClass: "bg-accent-gold",
      label: "Degraded",
      priority: 1,
    }))
    .with("major", () => ({
      dotClass: "bg-accent-red",
      label: "Major Outage",
      priority: 2,
    }))
    .with("critical", () => ({
      dotClass: "bg-accent-red",
      label: "Critical Outage",
      priority: 3,
    }))
    .exhaustive();
}

/**
 * Derive worst-case indicator across all providers.
 * Returns null when everything is operational — caller renders nothing.
 */
export function getWorstIndicator(
  statuses: Array<{ providerId: string; indicator: StatuspageIndicator }>
): { indicator: StatuspageIndicator; affectedProviders: string[] } | null {
  const nonOperational = statuses.filter((s) => s.indicator !== "none");
  if (nonOperational.length === 0) return null;

  const worst = nonOperational.reduce((a, b) =>
    getIndicatorVisuals(a.indicator).priority >= getIndicatorVisuals(b.indicator).priority ? a : b
  );

  return {
    indicator: worst.indicator,
    affectedProviders: nonOperational.map((s) => s.providerId),
  };
}
