// backend/src/services/agent/cloud/config.ts
// Cloud-workspace (agnt) connection config.
//
// v1 is environment-driven: the Deus Cloud auth handshake (WorkOS → deus-cloud
// exchange → per-device agnt key) replaces this in D1. Until then the three
// values below make the cloud lane available; absent key = lane disabled with
// honest errors at the create/send boundaries.

export interface CloudConfig {
  /** agnt backend base URL (REST + session WebSockets). */
  baseUrl: string;
  /** Organization API key (agnt_sk_*). */
  apiKey: string;
  /** BYOK Anthropic key for turn execution (proxied sandbox-side, turn-scoped). */
  anthropicApiKey: string | null;
}

let cached: CloudConfig | null | undefined;

/** Read the cloud config once per process. `null` = cloud lane disabled. */
export function getCloudConfig(): CloudConfig | null {
  if (cached !== undefined) return cached;
  const apiKey = process.env.DEUS_CLOUD_AGNT_API_KEY ?? process.env.AGNT_API_KEY ?? "";
  if (!apiKey) {
    cached = null;
    return cached;
  }
  cached = {
    baseUrl: (
      process.env.DEUS_CLOUD_AGNT_URL ??
      process.env.AGNT_BASE_URL ??
      "https://api.deusmachine.ai"
    ).replace(/\/$/, ""),
    apiKey,
    anthropicApiKey: process.env.DEUS_CLOUD_ANTHROPIC_KEY ?? process.env.ANTHROPIC_API_KEY ?? null,
  };
  return cached;
}

export function isCloudEnabled(): boolean {
  return getCloudConfig() !== null;
}

/** Test seam: clear the memoized config. */
export function resetCloudConfigForTests(): void {
  cached = undefined;
}
