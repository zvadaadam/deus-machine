// backend/src/services/cloud-workspace-init.service.ts
// Cloud-workspace creation pipeline (agnt lane).
//
// Mirrors the local init contract without the worktree: insert the row in
// 'initializing', return immediately, and let the background half provision
// the agnt workspace + session. Progress rides workspace.state events once the
// session socket opens (driver → init_stage), so there is no polling and no
// wait-for-ready here — the sandbox may still be provisioning when the user
// sends the first prompt; agnt queues it and runs it when the sidecar is up.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { v7 as uuidv7 } from "uuid";
import {
  createWorkspace as agntCreateWorkspace,
  createSession as agntCreateSession,
  stopWorkspace as agntStopWorkspace,
  resumeWorkspace as agntResumeWorkspace,
  getWorkspace as agntGetWorkspace,
  createSecret as agntCreateSecret,
  listSecrets as agntListSecrets,
  deleteSecret as agntDeleteSecret,
  Environment,
} from "@deus-hq/sdk";
import { githubRepoSlug, httpsOrigin } from "@shared/git-origin";
import { getDatabase } from "../lib/database";
import { getRepositoryById } from "../db";
import { invalidate } from "./query-engine";
import { generateUniqueName } from "./workspace.service";
import { getCloudConfig } from "./agent/cloud/config";
import { ensureCloudSession, announceCloudEnv } from "./agent/cloud/driver";
import { getCloudEnvironmentInfo } from "./cloud-environment.service";

const execFileAsync = promisify(execFile);

const WORKSPACE_RESOURCES = ["workspaces", "sessions", "session", "stats"] as const;

/** Provisioning waits on the mint, so it must fail fast rather than park the row. */
const MINT_TIMEOUT_MS = 10_000;

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
  const sourceBranch = params.sourceBranch || repo.git_default_branch || "main";
  // The sandbox works on its OWN branch off the source (parity with local
  // worktrees): PRs need head ≠ base, and the turn-end wip snapshots hang off
  // this branch's history.
  const workBranch = slug;

  db.prepare(
    `INSERT INTO workspaces (
       id, repository_id, slug, kind, git_branch, git_target_branch,
       state, init_stage, updated_at
     ) VALUES (?, ?, ?, 'cloud', ?, ?, 'initializing', 'creating cloud workspace', datetime('now'))`
  ).run(workspaceId, params.repositoryId, slug, workBranch, sourceBranch);
  invalidate([...WORKSPACE_RESOURCES], {});

  void provisionInBackground(
    workspaceId,
    httpsOrigin(repo.git_origin_url),
    { source: sourceBranch, work: workBranch },
    config.baseUrl,
    config.apiKey
  );

  return { workspaceId, slug };
}

/**
 * Delete the hidden durability ref (refs/agnt/wip/<providerWorkspaceId>) from
 * the repo's origin. Archive-time hygiene: the sandbox is being stopped, the
 * workspace is closed — nothing should linger in the user's repository. Runs
 * through the LOCAL gh auth (works when the sandbox is already dead) and is
 * strictly best-effort: a missing ref or missing gh is not an error.
 */
export async function deleteCloudWipRef(
  originUrl: string,
  providerWorkspaceId: string
): Promise<void> {
  const slug = githubRepoSlug(originUrl);
  if (!slug) return;
  const [owner, repoName] = slug.split("/");
  try {
    await execFileAsync(
      "gh",
      [
        "api",
        "-X",
        "DELETE",
        `repos/${owner}/${repoName}/git/refs/agnt/wip/${providerWorkspaceId}`,
      ],
      { timeout: 15_000 }
    );
  } catch {
    // Ref never existed (no turns ran), token lacks scope, or gh is absent.
  }
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

/** Platform-truth status of the sandbox ("paused" | "stopped" | "running" | ...), null if unreachable. */
async function getCloudWorkspaceStatus(providerWorkspaceId: string): Promise<string | null> {
  const config = getCloudConfig();
  if (!config) return null;
  try {
    const summary = await agntGetWorkspace(providerWorkspaceId, {
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
    });
    return typeof summary?.status === "string" ? summary.status : null;
  } catch {
    return null;
  }
}

/**
 * Re-mint the App token for a workspace about to start — BOTH lanes.
 *
 * The refresh has to land in two places, because a sandbox reads credentials
 * from two places:
 *  - the DO's stored secret map, replayed on stopped→reprovision. agnt's
 *    ensureWorkspace existing-row path takes request-fresh secrets with
 *    row-truth recipe, and ensureInitialized REFRESHES state.secrets on
 *    identity match — so an idempotent re-create with only { workspaceId,
 *    secrets } is the sanctioned refresh seam (ensureProvisioning is a no-op
 *    for running/paused sandboxes).
 *  - the platform's environment-scoped secret (env lane), resolved at that
 *    same re-create.
 * The third place — the thawed filesystem of a PAUSED sandbox — is agnt's
 * side of this seam: resumeSandbox rewrites .git-credentials from the DO's
 * refreshed map.
 */
export async function refreshWorkspaceGithubToken(workspace: {
  repository_id: string | null;
  provider_workspace_id?: string | null;
}): Promise<void> {
  if (!workspace.repository_id) return;
  const config = getCloudConfig();
  // Mint preconditions, hoisted ABOVE the env-info round-trip: without a
  // deus-cloud session there is nothing this function can do, and it runs on
  // the send path with the user's spinner already up.
  if (!config?.deusCloudUrl || !config.deusCloudSessionToken || !config.orgId) return;
  const originUrl = getRepositoryById(getDatabase(), workspace.repository_id)?.git_origin_url;
  if (!originUrl) return;
  const envInfo = await getCloudEnvironmentInfo(originUrl);

  if (envInfo.configured && envInfo.environmentId) {
    await refreshEnvironmentGithubTokenOnce(
      originUrl,
      envInfo.environmentId,
      config.baseUrl,
      config.apiKey
    );
    if (workspace.provider_workspace_id) {
      // Re-resolve the (just-refreshed) environment secrets into the DO's
      // stored map, so a stopped→reprovision replays the fresh token.
      await agntCreateWorkspace({
        workspaceId: workspace.provider_workspace_id,
        environment: envInfo.name,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
      }).catch((err) => {
        console.warn(`[CloudInit] DO secret refresh (env lane) failed: ${err}`);
      });
    }
    return;
  }

  // Inline lane: the mint was baked into the DO's map at create time, where
  // it SHADOWS the org PAT. Push a fresh one through the re-create seam.
  if (!workspace.provider_workspace_id) return;
  const token = await mintRepoInstallationToken(originUrl);
  if (!token) return;
  await agntCreateWorkspace({
    workspaceId: workspace.provider_workspace_id,
    environment: Environment.from("agnt-base").secrets({ github_token: token }),
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
  }).catch((err) => {
    console.warn(`[CloudInit] DO secret refresh (inline lane) failed: ${err}`);
  });
}

const githubTokenRefreshes = new Map<string, Promise<void>>();

/**
 * The explicit wake (chip click). Every outcome must be VISIBLE — a wake that
 * does nothing reads as broken — so each path announces itself on the chat's
 * ephemeral cloud:env pipe and moves the row's init_stage (the header chip):
 *
 *   paused  → "resuming" line + resume; failure reverts honestly to paused
 *   stopped → no doomed resume (agnt only resumes PAUSED); the line says a
 *             message-send restarts it (requestConnection re-provisions)
 *   running/provisioning/unknown → nothing to resume; reconnect refreshes truth
 */

export async function wakeCloudWorkspaceWithFeedback(workspace: {
  id: string;
  provider_workspace_id: string;
  current_session_id: string | null;
  repository_id?: string | null;
}): Promise<{ ok: boolean; status: string }> {
  const db = getDatabase();
  const sessionId = workspace.current_session_id;
  const announce = (data: Record<string, unknown>) => {
    if (sessionId) announceCloudEnv(workspace.id, sessionId, data);
  };
  const setStage = (stage: string | null) => {
    db.prepare("UPDATE workspaces SET init_stage = ? WHERE id = ?").run(stage, workspace.id);
    invalidate(["workspaces", "stats"], {});
  };

  const status = await getCloudWorkspaceStatus(workspace.provider_workspace_id);

  if (status === "stopped") {
    setStage("stopped");
    announce({ status: "stopped", reason: "send a message to restart it" });
    return { ok: true, status: "stopped" };
  }

  if (status === "paused" || status === null) {
    setStage("resuming");
    announce({ status: "resuming" });
    try {
      // A sandbox asleep longer than an hour holds an expired App mint;
      // re-mint BEFORE the resume. Inside the try: a throw here must take
      // the same honest revert to "paused" as a failed resume, not strand
      // the row on a permanent "resuming" spinner.
      await refreshWorkspaceGithubToken({
        repository_id: workspace.repository_id ?? null,
        provider_workspace_id: workspace.provider_workspace_id,
      });
      await wakeCloudWorkspace(workspace.provider_workspace_id);
    } catch (err) {
      console.warn(`[WORKSPACE] cloud wake resume failed: ${err}`);
      setStage("paused");
      announce({ status: "paused", reason: "resume failed — try again or send a message" });
      return { ok: false, status: "paused" };
    }
  }

  if (sessionId) {
    try {
      await ensureCloudSession(sessionId);
    } catch (err) {
      // The resume may have succeeded; the channel reconnects on the next
      // send — a transient connect failure must not fail the wake.
      console.warn(`[WORKSPACE] cloud wake reconnect failed (continuing): ${err}`);
    }
  }
  invalidate(["workspaces", "stats"], {});
  return { ok: true, status: status ?? "unknown" };
}

/** Wake a paused sandbox (explicit resume; sends also auto-resume). */
async function wakeCloudWorkspace(providerWorkspaceId: string): Promise<void> {
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
  /** A cloud turn can actually run: subscription token or API key present. */
  hasTurnCredential: boolean;
  hasGithubToken: boolean;
}> {
  const config = getCloudConfig();
  if (!config) {
    return {
      enabled: false,
      baseUrl: null,
      hasAnthropicKey: false,
      hasTurnCredential: false,
      hasGithubToken: false,
    };
  }
  let hasGithubToken = false;
  // A second device in the same org may hold NO local Claude token while the
  // canonical CLAUDE_CODE_OAUTH_TOKEN platform secret exists — the session DO
  // fills it at dispatch, so turns are runnable and the status must say so.
  let hasPlatformClaude = false;
  let hasPlatformCodex = false;
  try {
    for await (const secret of agntListSecrets({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
    })) {
      if (secret.keyName === "CLAUDE_CODE_OAUTH_TOKEN") hasPlatformClaude = true;
      if (secret.keyName === "CODEX_AUTH_JSON") hasPlatformCodex = true;
      if (hasGithubToken) continue; // both flags found by scanning the FULL list
      if (secret.keyName.toLowerCase() !== "github_token") continue;
      // Only an ORG-WIDE secret is the user's PAT. Provisioning also writes
      // short-lived, environment-scoped `github_token` App mints; counting
      // those would make Settings claim a personal token is saved when none
      // is, and mark the repo-access step done off a credential that expires
      // in an hour.
      if (secret.appliesToAll === false) continue;
      // No break: an org-wide github_token yielded BEFORE the Claude entry
      // must not stop the scan and leave hasPlatformClaude iteration-order
      // dependent.
      hasGithubToken = true;
    }
  } catch (err) {
    console.warn(`[CloudSettings] listSecrets failed: ${err instanceof Error ? err.message : err}`);
  }
  return {
    enabled: true,
    baseUrl: config.baseUrl,
    hasAnthropicKey: Boolean(config.anthropicApiKey),
    hasTurnCredential:
      Boolean(config.claudeOauthToken || config.anthropicApiKey) ||
      hasPlatformClaude ||
      hasPlatformCodex,
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

/**
 * Mint a per-repo GitHub App installation token via deus-cloud (1-hour,
 * down-scoped to exactly this repository). Best-effort by design: missing
 * mint context, an expired session, an uncovered repo, or an unregistered
 * App all resolve to null — the workspace then rides the org PAT secret
 * (or clones anonymously when the repo is public).
 */
async function mintRepoInstallationToken(originUrl: string): Promise<string | null> {
  const config = getCloudConfig();
  if (!config?.deusCloudUrl || !config.deusCloudSessionToken || !config.orgId) return null;
  const slug = githubRepoSlug(originUrl);
  if (!slug) return null;
  try {
    const res = await fetch(
      `${config.deusCloudUrl}/orgs/${config.orgId}/github/installation-token`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.deusCloudSessionToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ repository: slug }),
        // This await sits on user-visible paths — before workspace creation
        // at provision time, and on the wake/send refresh — so an
        // unresponsive deus-cloud would otherwise stall them for undici's
        // 300s header timeout. Best-effort by design: giving up fast falls
        // back to the PAT path.
        signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
      }
    );
    if (!res.ok) {
      console.warn(`[CloudInit] GitHub App token mint unavailable (${res.status}) for ${slug}`);
      return null;
    }
    const body = (await res.json()) as { token?: string };
    return body.token ?? null;
  } catch {
    return null;
  }
}

/**
 * Upsert the environment-scoped `github_token` for a named environment.
 *
 * App mints expire in an hour, and an environment-scoped secret SHADOWS the
 * org-wide PAT of the same name — so a stale one is worse than none: it turns
 * "clone with the user's PAT" into "clone with an expired token" for every
 * wake after the first hour. Hence: re-mint before each start, and on mint
 * failure DELETE the scoped copy so resolution falls back to the org PAT
 * rather than replaying a dead token.
 */
/**
 * Single-flight per origin. Provisioning, wake, and send can all refresh the
 * same environment concurrently (two same-env workspaces provisioning at
 * once is routine) — and a FAILED refresh's delete branch must never race a
 * successful one's fresh write.
 */
function refreshEnvironmentGithubTokenOnce(
  originUrl: string,
  environmentId: string,
  baseUrl: string,
  apiKey: string
): Promise<void> {
  const inFlight = githubTokenRefreshes.get(originUrl);
  if (inFlight) return inFlight;
  const run = refreshEnvironmentGithubToken(originUrl, environmentId, baseUrl, apiKey).finally(
    () => {
      githubTokenRefreshes.delete(originUrl);
    }
  );
  githubTokenRefreshes.set(originUrl, run);
  return run;
}

async function refreshEnvironmentGithubToken(
  originUrl: string,
  environmentId: string,
  baseUrl: string,
  apiKey: string
): Promise<void> {
  const token = await mintRepoInstallationToken(originUrl);
  try {
    if (token) {
      await agntCreateSecret("github_token", token, {
        baseUrl,
        apiKey,
        environmentIds: [environmentId],
        appliesToAll: false,
      });
      return;
    }
    for await (const secret of agntListSecrets({ baseUrl, apiKey })) {
      if (secret.keyName.toLowerCase() !== "github_token") continue;
      if (secret.appliesToAll !== false) continue;
      // MUST be linked to the environment we are refreshing. Deleting the
      // first non-global github_token in the org would destroy a DIFFERENT
      // environment's working token — one failed mint here, and an unrelated
      // repo silently loses App access.
      if (!secret.environmentIds.includes(environmentId)) continue;
      await agntDeleteSecret(secret.id, { baseUrl, apiKey });
      break;
    }
  } catch (err) {
    // Best-effort, exactly like the inline path: a PAT (or a public repo)
    // still works, and the failure must not block provisioning or a wake.
    console.warn(`[CloudInit] environment-scoped GitHub token refresh failed: ${err}`);
  }
}

async function provisionInBackground(
  workspaceId: string,
  originUrl: string,
  branch: { source: string; work: string },
  baseUrl: string,
  apiKey: string
): Promise<void> {
  const db = getDatabase();
  try {
    // A specialized environment (agent-authored via agnt_configure_environment,
    // resolved by the derived repo name) wins; absence of one IS the default —
    // the inline recipe below, exactly as before.
    const envInfo = await getCloudEnvironmentInfo(originUrl);
    let environment: string | ReturnType<typeof Environment.from>;
    if (envInfo.configured) {
      // Named environments resolve their secrets FROM THE PLATFORM — the create
      // API rejects inline secrets alongside an environmentId — so the App
      // token cannot ride the request here. Without this, a repo that has been
      // through environment setup silently loses App access: the first
      // (inline) workspace clones fine, every later one clones anonymously and
      // fails on a private repo. So write the mint as an environment-scoped
      // secret just before create; agnt resolves it by environment id.
      if (envInfo.environmentId) {
        await refreshEnvironmentGithubTokenOnce(originUrl, envInfo.environmentId, baseUrl, apiKey);
      }
      environment = envInfo.name;
    } else {
      let recipe = Environment.from("agnt-base").repo(originUrl, branch.source);
      // Per-repo App token (short-lived, this repo only) rides as a request
      // secret: it drives agnt's git-auth step and NEVER lands in pg — the
      // DO refreshes secrets on every ensure, so each provision gets a
      // fresh mint instead of replaying a stale one.
      const githubToken = await mintRepoInstallationToken(originUrl);
      if (githubToken) recipe = recipe.secrets({ github_token: githubToken });
      environment = recipe;
    }
    const provider = await agntCreateWorkspace({
      baseUrl,
      apiKey,
      environment,
      // New branch off the source — the sandbox's whole life happens here.
      checkout: { branch: branch.work, from: branch.source },
    });
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
      // init_stage is deliberately KEPT: it names the stage that failed, and
      // the sidebar uses it to say "Cloud setup failed" instead of blaming a
      // sandbox that never existed.
      "UPDATE workspaces SET state = 'error', error_message = ? WHERE id = ?"
    ).run(`Cloud provisioning failed: ${message}`, workspaceId);
    invalidate([...WORKSPACE_RESOURCES], {});
  }
}
