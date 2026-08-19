// backend/src/services/cloud-environment.service.ts
// The repo→environment link and its platform lookup.
//
// Cloud environments are agent-authored: the sandbox agent explores a repo,
// verifies its setup by running it, and persists the config via agnt's
// configure_environment tool. This service is deus's half of the link — it
// derives the same deterministic name the platform derives, so both sides
// resolve the same environment with no mapping table anywhere (and nothing
// machine-local to lose when switching computers).

import { getEnvironment as agntGetEnvironment } from "@deus-hq/sdk";
import { getCloudConfig } from "./agent/cloud/config";
import { httpsOrigin } from "./cloud-workspace-init.service";

/**
 * Deterministic org-unique environment name for a repository — MUST match
 * agnt's environmentNameForRepo byte for byte (the name IS the repo→env
 * link; both sides derive it independently, no mapping table anywhere).
 * Shape: repo-<slug>-<hash8> over the https-normalized origin.
 */
export async function environmentNameForRepo(repoRef: string): Promise<string> {
  const normalized = repoRef
    .trim()
    .toLowerCase()
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  const hash8 = [...new Uint8Array(digest)]
    .slice(0, 4)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const tail = normalized.split("/").filter(Boolean).slice(-2).join("-");
  // Truncate the SLUG, never the hash — a tail-truncated name would let two
  // long same-prefix repos collide on one environment. 5+100+1+8 ≤ 128.
  const slug = tail
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100);
  return `repo-${slug ? `${slug}-` : ""}${hash8}`;
}

export interface CloudEnvironmentInfo {
  /** A specialized environment exists for this repo on the platform. */
  configured: boolean;
  name: string;
  environmentId?: string;
  /** Env var NAMES the environment declares it needs (values = secrets). */
  requiredEnv?: string[];
}

/** Platform lookup of the repo's specialized environment (by derived name). */
export async function getCloudEnvironmentInfo(
  repoOriginUrl: string
): Promise<CloudEnvironmentInfo> {
  const name = await environmentNameForRepo(httpsOrigin(repoOriginUrl));
  const config = getCloudConfig();
  if (!config) return { configured: false, name };
  try {
    const env = await agntGetEnvironment(name, { baseUrl: config.baseUrl, apiKey: config.apiKey });
    const envConfig = (env?.config ?? {}) as { requiredEnv?: string[] };
    return {
      configured: true,
      name,
      environmentId: env.id,
      ...(Array.isArray(envConfig.requiredEnv) ? { requiredEnv: envConfig.requiredEnv } : {}),
    };
  } catch (err) {
    // Not-found is the normal "no specialized environment" answer. Anything
    // else (platform down, auth) also degrades to the inline default — but
    // audibly, so a misconfigured stack doesn't read as "never configured".
    const status = (err as { statusCode?: number }).statusCode;
    if (status !== 404) {
      console.warn(`[CloudEnv] environment lookup failed (treating as unconfigured): ${err}`);
    }
    return { configured: false, name };
  }
}
