// backend/src/services/cloud-workspace-init.service.ts
// Cloud-workspace creation pipeline (agnt lane).
//
// Mirrors the local init contract without the worktree: insert the row in
// 'initializing', return immediately, and let the background half provision
// the agnt workspace + session. Progress rides workspace.state events once the
// session socket opens (driver → init_stage), so there is no polling and no
// wait-for-ready here — the sandbox may still be provisioning when the user
// sends the first prompt; agnt queues it and runs it when the sidecar is up.

import { v7 as uuidv7 } from "uuid";
import {
  createWorkspace as agntCreateWorkspace,
  createSession as agntCreateSession,
  stopWorkspace as agntStopWorkspace,
  resumeWorkspace as agntResumeWorkspace,
  createSecret as agntCreateSecret,
  listSecrets as agntListSecrets,
  Environment,
} from "@deus-hq/sdk";
import { getDatabase } from "../lib/database";
import { getRepositoryById } from "../db";
import { invalidate } from "./query-engine";
import { generateUniqueName } from "./workspace.service";
import { getCloudConfig } from "./agent/cloud/config";
import { ensureCloudSession } from "./agent/cloud/driver";

const WORKSPACE_RESOURCES = ["workspaces", "sessions", "session", "stats"] as const;

/**
 * Normalize a git origin for sandbox cloning: ssh/scp forms → https.
 * Sandboxes carry no ssh keys — https clones work anonymously for public
 * repos and via the org's `github_token` secret for private ones (agnt's
 * git-auth step writes https credentials and already rewrites ssh→https,
 * but only WHEN a token exists; normalizing here makes public ssh-origin
 * repos work with no token at all).
 */
export function httpsOrigin(url: string): string {
  const scp = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(url);
  if (scp) return `https://${scp[1]}/${scp[2]}`;
  const ssh = /^ssh:\/\/(?:git@)?([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  return url;
}

export interface CreateCloudWorkspaceParams {
  repositoryId: string;
  /** Branch the sandbox checks out; defaults to the repo's default branch. */
  sourceBranch?: string;
}

/**
 * Create a cloud workspace: row now, sandbox in the background.
 * Throws synchronously for everything the user must fix (no config, repo
 * without a remote); background failures land on the row as state='error'.
 */
export function createCloudWorkspace(params: CreateCloudWorkspaceParams): {
  workspaceId: string;
  slug: string;
} {
  const config = getCloudConfig();
  if (!config) {
    throw new Error(
      "Cloud workspaces are not configured — set DEUS_CLOUD_AGNT_API_KEY (and DEUS_CLOUD_AGNT_URL for a non-production backend)."
    );
  }

  const db = getDatabase();
  const repo = getRepositoryById(db, params.repositoryId);
  if (!repo) throw new Error(`Repository not found: ${params.repositoryId}`);
  if (!repo.git_origin_url) {
    throw new Error(
      "Cloud workspaces need a git remote: this repository has no origin URL for the sandbox to clone."
    );
  }

  const workspaceId = uuidv7();
  const slug = generateUniqueName(db);
  const branch = params.sourceBranch || repo.git_default_branch || "main";

  db.prepare(
    `INSERT INTO workspaces (
       id, repository_id, slug, kind, git_branch, git_target_branch,
       state, init_stage, updated_at
     ) VALUES (?, ?, ?, 'cloud', ?, ?, 'initializing', 'creating cloud workspace', datetime('now'))`
  ).run(workspaceId, params.repositoryId, slug, branch, branch);
  invalidate([...WORKSPACE_RESOURCES], {});

  void provisionInBackground(
    workspaceId,
    httpsOrigin(repo.git_origin_url),
    branch,
    config.baseUrl,
    config.apiKey
  );

  return { workspaceId, slug };
}

/** Stop the agnt sandbox behind an archived cloud workspace (best-effort). */
export async function stopCloudWorkspace(providerWorkspaceId: string): Promise<void> {
  const config = getCloudConfig();
  if (!config) return;
  await agntStopWorkspace(providerWorkspaceId, {
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
  });
}

/** Wake a paused sandbox (explicit resume; sends also auto-resume). */
export async function wakeCloudWorkspace(providerWorkspaceId: string): Promise<void> {
  const config = getCloudConfig();
  if (!config) throw new Error("Cloud workspaces are not configured");
  await agntResumeWorkspace(providerWorkspaceId, {
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
  });
}

/** Settings surface: connection + secret status for the Cloud section. */
export async function getCloudSettingsStatus(): Promise<{
  enabled: boolean;
  baseUrl: string | null;
  hasAnthropicKey: boolean;
  hasGithubToken: boolean;
}> {
  const config = getCloudConfig();
  if (!config) {
    return { enabled: false, baseUrl: null, hasAnthropicKey: false, hasGithubToken: false };
  }
  let hasGithubToken = false;
  try {
    for await (const secret of agntListSecrets({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
    })) {
      const name =
        (secret as { keyName?: string; name?: string }).keyName ??
        (secret as { name?: string }).name;
      if (name?.toLowerCase() === "github_token") {
        hasGithubToken = true;
        break;
      }
    }
  } catch (err) {
    console.warn(`[CloudSettings] listSecrets failed: ${err instanceof Error ? err.message : err}`);
  }
  return {
    enabled: true,
    baseUrl: config.baseUrl,
    hasAnthropicKey: Boolean(config.anthropicApiKey),
    hasGithubToken,
  };
}

/** Store the org github_token secret (unlocks private repos in sandboxes). */
export async function saveCloudGithubToken(token: string): Promise<void> {
  const config = getCloudConfig();
  if (!config) throw new Error("Cloud workspaces are not configured");
  await agntCreateSecret("github_token", token, {
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    appliesToAll: true,
  });
}

async function provisionInBackground(
  workspaceId: string,
  originUrl: string,
  branch: string,
  baseUrl: string,
  apiKey: string
): Promise<void> {
  const db = getDatabase();
  try {
    const environment = Environment.from("agnt-base").repo(originUrl, branch);
    const provider = await agntCreateWorkspace({ baseUrl, apiKey, environment });
    db.prepare(
      "UPDATE workspaces SET provider_workspace_id = ?, init_stage = 'creating cloud session' WHERE id = ?"
    ).run(provider.id, workspaceId);
    invalidate([...WORKSPACE_RESOURCES], {});

    const providerSession = await agntCreateSession({ baseUrl, apiKey, workspaceId: provider.id });
    const sessionId = uuidv7();
    db.transaction(() => {
      db.prepare(
        "INSERT INTO sessions (id, workspace_id, provider_session_id, status, updated_at) VALUES (?, ?, ?, 'idle', datetime('now'))"
      ).run(sessionId, workspaceId, providerSession.id);
      db.prepare(
        "UPDATE workspaces SET current_session_id = ?, init_stage = 'provisioning sandbox' WHERE id = ?"
      ).run(sessionId, workspaceId);
    })();
    invalidate([...WORKSPACE_RESOURCES], {});

    // Open the session socket now: workspace.state events drive init_stage →
    // 'ready', and the first user send needs the channel anyway. A socket
    // failure here is NOT a provisioning failure — the workspace and session
    // exist and the sandbox keeps provisioning; the next send (or the wake
    // button) reconnects. Marking the row 'error' would report a dead
    // workspace for a transient connect problem.
    try {
      await ensureCloudSession(sessionId);
    } catch (err) {
      console.warn(
        `[CloudInit] session channel connect failed for ${workspaceId} (send/wake will retry): ${err}`
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[CloudInit] provisioning failed for ${workspaceId}: ${message}`);
    db.prepare(
      "UPDATE workspaces SET state = 'error', error_message = ?, init_stage = NULL WHERE id = ?"
    ).run(`Cloud provisioning failed: ${message}`, workspaceId);
    invalidate([...WORKSPACE_RESOURCES], {});
  }
}
