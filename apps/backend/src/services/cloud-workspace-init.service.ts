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
import type { CloudRepoAccess, CloudRepoAccessStatus } from "@shared/types/cloud-access";
import { getDatabase } from "../lib/database";
import { getRepositoryById } from "../db";
import { invalidate } from "./query-engine";
import { generateUniqueName } from "./workspace.service";
import { getCloudConfig } from "./agent/cloud/config";
import {
  ensureCloudSession,
  announceCloudEnv,
  getCloudIdentityGeneration,
} from "./agent/cloud/driver";
import {
  getCloudEnvironmentInfo,
  enableCloudEnvironmentSimulator,
} from "./cloud-environment.service";

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
 *
 * Returns whether the idempotent re-create was actually invoked — that call
 * is ALSO what restarts a stopped sandbox, so callers using this as the
 * restart vehicle must treat false as "nothing moved" (unconfigured cloud,
 * no origin, identity change mid-lookup) and revert their optimistic state.
 */
export async function refreshWorkspaceGithubToken(workspace: {
  repository_id: string | null;
  provider_workspace_id?: string | null;
}): Promise<boolean> {
  if (!workspace.repository_id) return false;
  const config = getCloudConfig();
  // Only the AGNT config gates this function: the deus-cloud session bits
  // gate the MINT, and mintRepoInstallationToken already no-ops to null
  // without them — the tokenless re-create (public repos, org-PAT setups,
  // env-key-only configs) must still run, because it is ALSO the restart
  // vehicle for stopped sandboxes.
  if (!config) return false;
  const originUrl = getRepositoryById(getDatabase(), workspace.repository_id)?.git_origin_url;
  if (!originUrl) return false;
  const generationAtStart = getCloudIdentityGeneration();
  const envInfo = await getCloudEnvironmentInfo(originUrl);
  if (envInfo.lookupFailed) {
    // UNKNOWN is not unconfigured: falling through to the inline lane would
    // re-create a NAMED-environment workspace from agnt-base and replace its
    // DO secret map (env vars, credentials) with the inline defaults — a
    // transient platform blip must never rewrite durable state. Report
    // no-op; wake callers revert honestly, sends surface the retryable miss.
    return false;
  }
  if (generationAtStart !== getCloudIdentityGeneration()) {
    // The account changed while the lookup was in flight. The identity
    // handler's clear() ran BEFORE this call would register its flight, so
    // clearing alone cannot cover this interval — a stale registration here
    // would hand the new account an old-credential refresh. Bail; the new
    // identity's own send/wake path refreshes with its own config.
    return false;
  }

  if (envInfo.configured && envInfo.environmentId) {
    await refreshEnvironmentGithubTokenOnce(
      originUrl,
      envInfo.environmentId,
      config.baseUrl,
      config.apiKey
    );
    if (workspace.provider_workspace_id) {
      // Re-resolve the (just-refreshed) environment secrets into the DO's
      // stored map, so a stopped→reprovision replays the fresh token. NOT
      // best-effort: ensureProvisioning inside this call is ALSO what
      // restarts a stopped sandbox (chip + send paths) — swallowing its
      // failure reported successful wakes over a sandbox that never moved,
      // and resumes rewriting auth files from a stale map.
      await agntCreateWorkspace({
        workspaceId: workspace.provider_workspace_id,
        environment: envInfo.name,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
      });
      return true;
    }
    return false;
  }

  // Inline lane: the mint was baked into the DO's map at create time, where
  // it SHADOWS the org PAT. Push a fresh one through the re-create seam.
  // A DEFINITIVE null mint (deus-cloud answered "no access": no App install
  // — PAT/public-repo workspaces) does not skip the call: the re-create
  // resolves org-wide secrets server-side, so an omitted github_token
  // REMOVES the stale inline mint from the map and lets the PAT (or
  // anonymous clone) win again — and the restart-by-recreate still happens
  // for tokenless workspaces. An UNKNOWN mint outcome (timeout/5xx/missing
  // context) must NOT strip the map: a ten-second deus-cloud blip would
  // otherwise blank a working sandbox's git access on the next wake. The
  // stored token keeps working until its own expiry; the next refresh
  // retries.
  if (!workspace.provider_workspace_id) return false;
  const mint = await mintRepoInstallationToken(originUrl);
  if (!mint.token && !mint.definitive) {
    // Unknown outcome — proceed with the tokenless re-create only when the
    // DO map provably holds nothing worth protecting: stamp 0 = the map is
    // KNOWN tokenless (created/last refreshed without a mint — nothing to
    // strip, so the restart must not be blocked), stamp older than the
    // token's 1-hour life = expired either way (only shadows the org PAT).
    // null = legacy row from before stamping — can't prove anything, keep
    // the status-quo protection.
    const stampedAt = getInlineMintStamp(workspace);
    const mapProvablyStrippable =
      stampedAt === 0 || (stampedAt !== null && Date.now() - stampedAt > 55 * 60_000);
    if (!mapProvablyStrippable) return false;
  }
  await agntCreateWorkspace({
    workspaceId: workspace.provider_workspace_id,
    // `.simulator()` on BOTH inline recipes (this re-create and the create in
    // createCloudWorkspace): agnt converges the DO's environment config on
    // re-create, so a token refresh without it would silently drop the
    // hosted-device support the workspace was born with.
    environment: mint.token
      ? Environment.from("agnt-base").simulator().secrets({ github_token: mint.token })
      : Environment.from("agnt-base").simulator(),
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
  });
  setInlineMintStamp(workspace, mint.token ? Date.now() : 0);
  return true;
}

/** last_inline_mint_at accessors — see the schema comment for semantics. */
function getInlineMintStamp(workspace: { provider_workspace_id?: string | null }): number | null {
  if (!workspace.provider_workspace_id) return null;
  const row = getDatabase()
    .prepare("SELECT last_inline_mint_at FROM workspaces WHERE provider_workspace_id = ?")
    .get(workspace.provider_workspace_id) as { last_inline_mint_at?: number | null } | undefined;
  return row?.last_inline_mint_at ?? null;
}

function setInlineMintStamp(
  workspace: { provider_workspace_id?: string | null },
  stamp: number | null
): void {
  if (!workspace.provider_workspace_id) return;
  getDatabase()
    .prepare("UPDATE workspaces SET last_inline_mint_at = ? WHERE provider_workspace_id = ?")
    .run(stamp, workspace.provider_workspace_id);
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
  let finalStatus = status ?? "unknown";

  if (status === "stopped") {
    // Restart, don't shrug: ensureWorkspace's ensureProvisioning reprovisions
    // a stopped sandbox, and refreshWorkspaceGithubToken routes through that
    // exact re-create seam (with a FRESH mint — the stored one is long dead).
    // The chip flips to Waking now; agnt's provisioning state frames take
    // over the story on the session channel the shared tail below attaches
    // (do NOT return early — after a backend restart no socket exists yet,
    // and without one the frames have nowhere to land and the chip would
    // stick on Waking forever).
    setStage("resuming");
    announce({ status: "resuming", step: "Restarting sandbox" });
    try {
      const restarted = await refreshWorkspaceGithubToken({
        repository_id: workspace.repository_id ?? null,
        provider_workspace_id: workspace.provider_workspace_id,
      });
      if (!restarted) {
        // Every early-out (unconfigured cloud, missing origin, identity
        // change) means the re-create never ran and NOTHING will move —
        // leaving "resuming" up would be a permanent lie.
        setStage("stopped");
        announce({ status: "stopped", reason: "restart unavailable — try sending a message" });
        return { ok: false, status: "stopped" };
      }
    } catch (err) {
      console.warn(`[WORKSPACE] cloud restart failed: ${err}`);
      setStage("stopped");
      announce({ status: "stopped", reason: "restart failed — try again or send a message" });
      return { ok: false, status: "stopped" };
    }
    finalStatus = "restarting";
  }

  if (status === "paused" || status === null) {
    setStage("resuming");
    announce({ status: "resuming" });
    try {
      // A sandbox asleep longer than an hour holds an expired App mint;
      // re-mint BEFORE the resume. This ALSO runs ensureProvisioning — the same
      // re-create seam the stopped path uses — so a gone/EXPIRED sandbox is
      // already coming back by the time the resume below runs. Inside the try:
      // a throw here must take the same honest revert to "paused" as a failed
      // resume, not strand the row on a permanent "resuming" spinner.
      const reprovisioned = await refreshWorkspaceGithubToken({
        repository_id: workspace.repository_id ?? null,
        provider_workspace_id: workspace.provider_workspace_id,
      });
      try {
        await wakeCloudWorkspace(workspace.provider_workspace_id);
      } catch (resumeErr) {
        // A gone/expired sandbox can't be resumed ("Workspace not found or not
        // paused"). But if the refresh above reprovisioned it, the computer is
        // already restarting as a fresh sandbox — that's a restart, not a
        // failure, so let agnt's provisioning frames take over (like stopped).
        const msg = resumeErr instanceof Error ? resumeErr.message : String(resumeErr);
        if (reprovisioned && /not\s+found|not\s+paused/i.test(msg)) {
          finalStatus = "restarting";
        } else {
          throw resumeErr;
        }
      }
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
  return { ok: true, status: finalStatus };
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
  /** A CLAUDE cloud turn can run — gates flows pinned to a Claude model. */
  hasClaudeTurnCredential: boolean;
  /** Canonical CODEX_AUTH_JSON exists on the platform — the web app's only
   *  codex-connected signal (no desktop vault there). */
  hasPlatformCodex: boolean;
  hasGithubToken: boolean;
}> {
  const config = getCloudConfig();
  if (!config) {
    return {
      enabled: false,
      baseUrl: null,
      hasAnthropicKey: false,
      hasTurnCredential: false,
      hasClaudeTurnCredential: false,
      hasPlatformCodex: false,
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
    // Claude-only readiness: the environment-setup flow pins its turn to a
    // Claude model, so its gate must NOT open on a codex-only credential.
    hasClaudeTurnCredential:
      Boolean(config.claudeOauthToken || config.anthropicApiKey) || hasPlatformClaude,
    hasPlatformCodex,
    hasGithubToken,
  };
}

/**
 * WEB-lane Codex connect: validate and store the pasted auth.json as the
 * canonical platform secret. Same validation as the desktop import; unlinked
 * (appliesToAll false) exactly like the desktop sync — turn credentials are
 * resolved per-dispatch by the session DO, never fanned into sandbox env.
 */
export async function saveCloudCodexAuth(authJson: string): Promise<void> {
  const config = getCloudConfig();
  if (!config) throw new Error("Cloud workspaces are not configured");
  let parsed: { auth_mode?: string; tokens?: { access_token?: string; refresh_token?: string } };
  try {
    parsed = JSON.parse(authJson) as typeof parsed;
  } catch {
    throw new Error("That isn't valid JSON — paste the full contents of ~/.codex/auth.json");
  }
  if (
    parsed.auth_mode !== "chatgpt" ||
    !parsed.tokens?.access_token ||
    !parsed.tokens?.refresh_token
  ) {
    // refresh_token required: an access-token-only paste works until first
    // expiry, then every cloud turn fails while Settings still reads
    // Connected off the secret's mere presence.
    throw new Error(
      "That auth.json isn't a complete ChatGPT-plan login (needs access AND refresh tokens) — run `codex login` (or `codex login --device-auth` on a headless machine) and paste the full file it writes."
    );
  }
  await agntCreateSecret("CODEX_AUTH_JSON", authJson, {
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    appliesToAll: false,
  });
}

export async function disconnectCloudCodexAuth(): Promise<void> {
  const config = getCloudConfig();
  if (!config) throw new Error("Cloud workspaces are not configured");
  // deleteSecret is id-addressed; resolve the entry by canonical name first.
  for await (const secret of agntListSecrets({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
  })) {
    if (secret.keyName !== "CODEX_AUTH_JSON") continue;
    const deleted = await agntDeleteSecret(secret.id, {
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
    });
    if (!deleted) throw new Error("The platform did not confirm the delete — try again.");
    return;
  }
  // Nothing to delete = already disconnected; not an error.
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
 * App all resolve to a null token — the workspace then rides the org PAT
 * secret (or clones anonymously when the repo is public).
 *
 * `definitive` is the DESTRUCTIVE-ACTION gate: true only when deus-cloud
 * positively answered "this identity may not mint for this repo" (403/404)
 * or the origin has no slug at all. A timeout, 5xx, network error or
 * missing mint context is an UNKNOWN — callers that remove or blank
 * existing credentials on a null token must not do so on unknowns, or a
 * ten-second deus-cloud blip strips a working sandbox of its git access.
 */
async function mintRepoInstallationToken(
  originUrl: string
): Promise<{ token: string | null; definitive: boolean }> {
  const config = getCloudConfig();
  // Missing mint context is DEFINITIVE: a deployment without a deus-cloud
  // session (env-key-only configs, or after an explicit sign-out) cannot
  // have minted the stored tokens it would be protecting — and treating it
  // as unknown permanently blocked the tokenless re-create that restarts
  // stopped sandboxes in exactly those deployments.
  if (!config?.deusCloudUrl || !config.deusCloudSessionToken || !config.orgId)
    return { token: null, definitive: true };
  const slug = githubRepoSlug(originUrl);
  if (!slug) return { token: null, definitive: true };
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
      // 404 is definitive ONLY when deus-cloud itself answered (its
      // AppError body is JSON: "No GitHub App installation for …"). A bare
      // routing 404 — GitHub routes not deployed yet, a worker fallthrough —
      // is a deployment skew, and stripping credentials on it would break a
      // working sandbox during a deploy mismatch.
      let definitive = res.status === 403;
      if (res.status === 404) {
        // Only deus-cloud's OWN answer is permission truth. Its AppError
        // serializes as { error: "NOT_FOUND", message: "No GitHub App
        // installation for <owner>", … } — a proxy/routing 404 (plain text,
        // {"error":"Not Found"}, null) must stay UNKNOWN, or a deployment
        // skew strips a working credential.
        const body = await res.text().catch(() => "");
        try {
          const parsed = JSON.parse(body) as { error?: unknown; message?: unknown } | null;
          definitive =
            parsed?.error === "NOT_FOUND" &&
            typeof parsed.message === "string" &&
            parsed.message.includes("GitHub App installation");
        } catch {
          definitive = false;
        }
      }
      return { token: null, definitive };
    }
    const body = (await res.json()) as { token?: string };
    return { token: body.token ?? null, definitive: body.token ? true : false };
  } catch {
    return { token: null, definitive: false };
  }
}

/**
 * Is this GitHub repo public — i.e. cloneable by a tokenless sandbox?
 *
 * Unauthenticated GitHub API: a public repo answers 200, a private (or
 * missing) one answers 404 — GitHub hides private repos from anonymous
 * callers. We deliberately send NO credential so the answer reflects what the
 * *sandbox* (which has none) can reach, NOT what the user's local git creds
 * can. TRI-STATE: 200 -> public, 404 -> private (invisible to anon), anything
 * else (rate-limit — the anon limit is 60/hr PER IP, a shared quota on the
 * hosted backend — 5xx, network) -> null = "couldn't tell". The null case is
 * what stops a rate-limited probe from being read as "private" and wrongly
 * emitting needs_grant on a public repo.
 */
async function isPublicGithubRepo(slug: string): Promise<boolean | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${slug}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "deus-machine" },
      signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
    });
    if (res.status === 200) return true;
    if (res.status === 404) return false;
    return null;
  } catch {
    return null;
  }
}

/** The App grant path is only usable when a deus-cloud session is configured. */
function isGrantPathConfigured(): boolean {
  const c = getCloudConfig();
  return !!(c?.deusCloudUrl && c.deusCloudSessionToken && c.orgId);
}

/**
 * The ONE access verdict, classified from an already-resolved mint — so a
 * caller that mints for its own reasons (provisioning needs the token itself)
 * reuses that result instead of minting twice. "ok" = the App covers it (a
 * token minted) OR the repo is public. Anything uncertain (the public probe
 * couldn't tell, or a non-definitive mint) is "unknown", which must NEVER
 * block: only a repo the App PROVABLY doesn't cover AND that is PROVABLY not
 * public becomes "needs_grant". Both the composer modal and the create-time
 * safety net classify through this, so the preview can't disagree with what
 * provisioning decides.
 */
async function classifyRepoAccess(
  slug: string,
  mint: { token: string | null; definitive: boolean }
): Promise<CloudRepoAccessStatus> {
  if (mint.token) return "ok";
  const isPublic = await isPublicGithubRepo(slug);
  if (isPublic) return "ok";
  if (isPublic === null) return "unknown"; // probe couldn't tell → never block
  // isPublic === false: provably not anonymously cloneable. Emit needs_grant
  // ONLY when the App IS the configured grant path — a definitive mint without
  // a deus-cloud session just means "no App configured" (an env-key / org-PAT
  // setup that clones private repos via the org PAT server-side), so prompting
  // to install an App that isn't in use would dead-end AND wrongly block a
  // create that succeeds via the PAT. That stays "unknown".
  if (mint.definitive && isGrantPathConfigured()) return "needs_grant";
  return "unknown";
}

/**
 * Can a cloud sandbox clone this repo right now? (See {@link CloudRepoAccess}.)
 * Backs the `cloudRepoAccess` request + the composer gate; the create-time
 * safety net classifies through the same {@link classifyRepoAccess}.
 *
 * No cloud session / no origin / non-GitHub origin all resolve to "unknown":
 * there is nothing to grant, and the composer only ever acts on "needs_grant".
 */
export async function resolveCloudRepoAccess(repoId: string): Promise<CloudRepoAccess> {
  if (!getCloudConfig()) return { status: "unknown", slug: null };
  const originUrl = getRepositoryById(getDatabase(), repoId)?.git_origin_url;
  if (!originUrl) return { status: "unknown", slug: null };
  const slug = githubRepoSlug(originUrl);
  if (!slug) return { status: "unknown", slug: null };
  const mint = await mintRepoInstallationToken(originUrl);
  return { status: await classifyRepoAccess(slug, mint), slug };
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
/** Environments already upgraded with device support this process — the
 *  platform's answer is durable, so one PUT per environment is enough. */
const simulatorEnabledEnvironments = new Set<string>();

async function enableEnvironmentSimulatorOnce(environmentId: string): Promise<void> {
  if (simulatorEnabledEnvironments.has(environmentId)) return;
  try {
    await enableCloudEnvironmentSimulator(environmentId);
    simulatorEnabledEnvironments.add(environmentId);
    console.log(`[CloudInit] enabled hosted devices on environment ${environmentId}`);
  } catch (err) {
    console.warn(
      `[CloudInit] could not enable hosted devices on environment ${environmentId}: ${err}`
    );
  }
}

function refreshEnvironmentGithubTokenOnce(
  originUrl: string,
  environmentId: string,
  baseUrl: string,
  apiKey: string
): Promise<void> {
  // Normalized key: provisioning passes the https form, wake/send pass the
  // raw stored origin — an ssh-form remote would otherwise key two separate
  // flights for the same environment and re-open the delete-vs-write race
  // the single-flight exists to close.
  const key = httpsOrigin(originUrl);
  const inFlight = githubTokenRefreshes.get(key);
  if (inFlight) return inFlight;
  const run: Promise<void> = refreshEnvironmentGithubToken(
    originUrl,
    environmentId,
    baseUrl,
    apiKey
  ).finally(() => {
    // Only OUR entry: the identity-change clear may have let a replacement
    // flight occupy this key — an unconditional delete would evict it and
    // reopen the delete-vs-write race (same guard as the driver's
    // connecting map).
    if (githubTokenRefreshes.get(key) === run) githubTokenRefreshes.delete(key);
  });
  githubTokenRefreshes.set(key, run);
  return run;
}

/**
 * Called by the driver's identity-change handler: in-flight refreshes were
 * minted under the PREVIOUS account, and the next account's provision must
 * not adopt (or be blocked by) them.
 */
export function clearGithubTokenRefreshFlights(): void {
  githubTokenRefreshes.clear();
}

async function refreshEnvironmentGithubToken(
  originUrl: string,
  environmentId: string,
  baseUrl: string,
  apiKey: string
): Promise<void> {
  const mint = await mintRepoInstallationToken(originUrl);
  try {
    if (mint.token) {
      await agntCreateSecret("github_token", mint.token, {
        baseUrl,
        apiKey,
        environmentIds: [environmentId],
        appliesToAll: false,
      });
      return;
    }
    // Delete the stored env token when deus-cloud POSITIVELY said this
    // identity may not mint — or when the stored token is provably PAST its
    // one-hour life. An unknown outcome keeps a token only while it can
    // still work: an expired scoped token is pure downside (it shadows the
    // org PAT while authenticating nothing), so age decides where the mint
    // couldn't.
    const keepUnknown = !mint.definitive;
    for await (const secret of agntListSecrets({ baseUrl, apiKey })) {
      if (secret.keyName.toLowerCase() !== "github_token") continue;
      if (secret.appliesToAll !== false) continue;
      // MUST be linked to the environment we are refreshing. Deleting the
      // first non-global github_token in the org would destroy a DIFFERENT
      // environment's working token — one failed mint here, and an unrelated
      // repo silently loses App access.
      if (!secret.environmentIds.includes(environmentId)) continue;
      if (keepUnknown) {
        // updatedAt, not createdAt: the platform UPSERTS this secret, so
        // createdAt is the row's birth — a freshly rotated token would read
        // as expired forever off it.
        const ageMs = Date.now() - Date.parse(secret.updatedAt ?? secret.createdAt ?? "");
        const stillPlausiblyValid = Number.isFinite(ageMs) && ageMs < 55 * 60_000;
        if (stillPlausiblyValid) break;
      }
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
    let inlineMintStampAtCreate: number | null = null;
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
        // Every cloud workspace shows a Simulator tab; an environment saved
        // before devices existed cannot honour it, and the recipe is captured
        // at create — so upgrade the environment FIRST (enabling is free:
        // billing starts with a device). Best-effort: the workspace still
        // provisions without it, and Start then says so.
        if (envInfo.simulator === false) {
          await enableEnvironmentSimulatorOnce(envInfo.environmentId);
        }
      }
      environment = envInfo.name;
    } else {
      // Every inline cloud workspace can host a device (the Simulator tab):
      // `.simulator()` only ENABLES it — billing starts when a device starts,
      // so the flag is free until the tab is used. Named environments (above)
      // are the agent's own config and are left alone.
      let recipe = Environment.from("agnt-base").repo(originUrl, branch.source).simulator();
      // Per-repo App token (short-lived, this repo only) rides as a request
      // secret: it drives agnt's git-auth step and NEVER lands in pg — the
      // DO refreshes secrets on every ensure, so each provision gets a
      // fresh mint instead of replaying a stale one.
      const mint = await mintRepoInstallationToken(originUrl);
      if (mint.token) {
        recipe = recipe.secrets({ github_token: mint.token });
        inlineMintStampAtCreate = Date.now();
      } else {
        // No App token. Classify through the SAME verdict the composer modal
        // uses, reusing the mint we just did (no second mint): a repo the App
        // provably doesn't cover AND that isn't public would die at `git clone`
        // with a cryptic auth error, so fail fast with an actionable message
        // instead of burning a sandbox. The modal prevents this in the UI; this
        // backstops any path that reaches create without it (a web race, access
        // revoked mid-flight). "unknown" (a transient blip / rate-limited probe)
        // still provisions. NOTE: only the INLINE lane — a repo with a named
        // environment resolves its token separately and relies on the modal.
        const slug = githubRepoSlug(originUrl);
        if (slug && (await classifyRepoAccess(slug, mint)) === "needs_grant") {
          db.prepare("UPDATE workspaces SET state = 'error', error_message = ? WHERE id = ?").run(
            `GitHub access required — install the Deus GitHub App for ${slug} to run it in the cloud.`,
            workspaceId
          );
          invalidate([...WORKSPACE_RESOURCES], {});
          return;
        }
        // The DO map is KNOWN tokenless from birth (nothing baked) — record
        // 0 so a later unknown-outcome restart isn't blocked protecting a
        // token that never existed.
        inlineMintStampAtCreate = 0;
      }
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
      "UPDATE workspaces SET provider_workspace_id = ?, init_stage = 'creating cloud session', last_inline_mint_at = ? WHERE id = ?"
    ).run(provider.id, inlineMintStampAtCreate, workspaceId);
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
