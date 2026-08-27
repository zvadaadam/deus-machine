// backend/src/services/cloud-environment.service.ts
// The repo→environment link and its platform lookup.
//
// Cloud environments are agent-authored: the sandbox agent explores a repo,
// verifies its setup by running it, and persists the config via agnt's
// configure_environment tool. This service is deus's half of the link — it
// derives the same deterministic name the platform derives, so both sides
// resolve the same environment with no mapping table anywhere (and nothing
// machine-local to lose when switching computers).

import {
  getEnvironment as agntGetEnvironment,
  listEnvironments as agntListEnvironments,
} from "@deus-hq/sdk";
import { getCloudConfig } from "./agent/cloud/config";
import { httpsOrigin } from "@shared/git-origin";

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
  /** Lookup ERRORED (non-404): configured:false here means UNKNOWN, not
   *  absent — state-rewriting callers must not act on it. */
  lookupFailed?: true;
}

export interface CloudEnvironmentSummary {
  id: string;
  name: string;
  /** Repo origin the environment is bound to (from its config), if any. */
  repo: string | null;
  updatedAt: string;
}

/**
 * All cloud environments on the org — the Settings list. Empty when the
 * cloud lane is unconfigured; capped defensively (a solo org has a handful).
 */
export async function listCloudEnvironments(): Promise<CloudEnvironmentSummary[]> {
  const config = getCloudConfig();
  if (!config) return [];
  const out: CloudEnvironmentSummary[] = [];
  try {
    for await (const env of agntListEnvironments({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
    })) {
      const envConfig = (env.config ?? {}) as { repo?: unknown };
      out.push({
        id: env.id,
        name: env.name,
        repo: typeof envConfig.repo === "string" ? envConfig.repo : null,
        updatedAt: env.updatedAt,
      });
      if (out.length >= 100) break;
    }
  } catch (err) {
    console.warn(`[CloudEnv] environment list failed: ${err}`);
  }
  return out;
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
    // else (platform down, auth) is UNKNOWN, not unconfigured — flagged so
    // callers that would REWRITE state off this answer (the refresh path's
    // inline lane replaces the DO's secret map) can refuse to act on it,
    // while read-only consumers may still degrade to the inline default.
    // The platform's not-found answer has shifted shape across builds: 404,
    // but also 400 with its "Environment not found" ValidationError (the
    // resolver's message). Either way the environment is ABSENT — only
    // genuinely unexpected failures stay UNKNOWN.
    const status = (err as { statusCode?: number }).statusCode;
    const message = err instanceof Error ? err.message : String(err);
    const notFound = status === 404 || /environment not found/i.test(message);
    if (!notFound) {
      console.warn(`[CloudEnv] environment lookup failed (result UNKNOWN): ${err}`);
      return { configured: false, name, lookupFailed: true };
    }
    return { configured: false, name };
  }
}
