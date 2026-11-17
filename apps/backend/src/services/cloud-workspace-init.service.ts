// backend/src/services/cloud-workspace-init.service.ts
// Cloud-workspace creation pipeline (agnt lane).
//
// Mirrors the local init contract without the worktree: insert the row in
// 'initializing', return immediately, and let the background half provision
// the agnt workspace + session. Progress rides workspace.state events once the
// session socket opens (driver → init_stage), so there is no polling and no
// wait-for-ready here — the sandbox may still be provisioning when the user
// sends the first prompt; agnt queues it and runs it when the sidecar is up.

import { uuidv7 } from "@shared/lib/uuid";
import {
  createWorkspace as agntCreateWorkspace,
  createSession as agntCreateSession,
  pauseWorkspace as agntPauseWorkspace,
  resumeWorkspace as agntResumeWorkspace,
  getWorkspace as agntGetWorkspace,
  createSecret as agntCreateSecret,
  listSecrets as agntListSecrets,
  deleteSecret as agntDeleteSecret,
  isDeusError,
  Environment,
} from "@deus-hq/sdk";
import type { RepositoryAuth } from "@deus-hq/api";
import { githubRepoSlug, httpsOrigin } from "@shared/git-origin";
import type { CloudRepoAccess, CloudRepoAccessStatus } from "@shared/types/cloud-access";
import { getDatabase } from "../lib/database";
import { ConflictError, NotFoundError, ValidationError } from "../lib/errors";
import { getRepositoryById } from "../db";
import { invalidate } from "./query-engine";
import { generateUniqueName } from "./workspace.service";
import {
  cloudAccount,
  cloudOrg,
  cloudOrgOf,
  requireCloudOrg,
  getCloudIdentitySignal,
  setCloudConnectHook,
  type CloudOrg,
} from "./agent/cloud/config";
import { getCloudWorkspaceUserId } from "./cloud-settings.service";
import { isPublicGithubRepo, mintRepoInstallationToken } from "./github-remote";
import {
  ensureCloudSession,
  announceCloudEnv,
  getCloudIdentityGeneration,
  hasLiveCloudSession,
} from "./agent/cloud/driver";
import {
  getCloudEnvironmentInfo,
  enableCloudEnvironmentSimulator,
} from "./cloud-environment.service";

const WORKSPACE_RESOURCES = ["workspaces", "sessions", "session"] as const;

export interface CreateCloudWorkspaceParams {
  repositoryId: string;
  /** Branch the sandbox checks out; defaults to the repo's default branch. */
  sourceBranch?: string;
  /** The organization it runs in; the default organization when omitted. */
  organizationId?: string | null;
}

/** The columns a cloud workspace's platform calls are derived from. */
interface CloudWorkspaceRef {
  provider_workspace_id?: string | null;
  organization_id?: string | null;
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
  if (!cloudAccount()) {
    throw new ValidationError(
      "Cloud workspaces are not configured — set DEUS_CLOUD_AGNT_API_KEY (and DEUS_CLOUD_AGNT_URL for a non-production backend)."
    );
  }
  const org = requireCloudOrg(params.organizationId);

  const db = getDatabase();
  const repo = getRepositoryById(db, params.repositoryId);
  if (!repo) throw new NotFoundError(`Repository not found: ${params.repositoryId}`);
  if (!repo.git_origin_url) {
    throw new ValidationError(
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
       organization_id, state, init_stage, updated_at
     ) VALUES (?, ?, ?, 'cloud', ?, ?, ?, 'initializing', 'creating cloud workspace', datetime('now'))`
  ).run(workspaceId, params.repositoryId, slug, workBranch, sourceBranch, org.orgId);
  invalidate([...WORKSPACE_RESOURCES], {});

  void provisionInBackground(
    workspaceId,
    httpsOrigin(repo.git_origin_url),
    { source: sourceBranch, work: workBranch },
    org
  );

  return { workspaceId, slug };
}

/**
 * Provision a failed cloud workspace again, on the same row. Only while no
 * computer exists for it: everything that fails before the platform is asked
 * for one (GitHub access, project settings, the request itself) is safe to
 * repeat. Once a computer exists, waking it is the way back.
 */
export function retryCloudWorkspace(workspaceId: string): void {
  if (!cloudAccount())
    throw new ValidationError("Sign in to Deus Cloud to try this workspace again.");
  const db = getDatabase();
  const workspace = db
    .prepare(
      "SELECT repository_id, git_branch, git_target_branch, organization_id FROM workspaces WHERE id = ? AND kind = 'cloud'"
    )
    .get(workspaceId) as
    | {
        repository_id: string;
        git_branch: string | null;
        git_target_branch: string | null;
        organization_id: string | null;
      }
    | undefined;
  const repo = workspace && getRepositoryById(db, workspace.repository_id);
  if (!workspace?.git_branch || !repo?.git_origin_url)
    throw new NotFoundError("Workspace not found");
  const org = requireCloudOrg(workspace.organization_id);
  // The claim: two clicks, or two devices, provision it once.
  const claimed = db
    .prepare(
      `UPDATE workspaces
       SET state = 'initializing', init_stage = 'creating cloud workspace',
           error_message = NULL, error_detail = NULL
       WHERE id = ? AND state = 'error' AND provider_workspace_id IS NULL`
    )
    .run(workspaceId);
  if (claimed.changes === 0) throw new ConflictError("This workspace is not waiting for a retry.");
  invalidate([...WORKSPACE_RESOURCES], {});
  void provisionInBackground(
    workspaceId,
    httpsOrigin(repo.git_origin_url),
    {
      source: workspace.git_target_branch || repo.git_default_branch || "main",
      work: workspace.git_branch,
    },
    org
  );
}

/** Archive suspends the VM and keeps both its filesystem and remote backups. */
export async function pauseCloudWorkspace(
  workspace: CloudWorkspaceRef & { provider_workspace_id: string }
): Promise<void> {
  if (!cloudAccount()) throw new ValidationError("Cloud workspaces are not configured");
  const config = requireCloudOrg(workspace.organization_id);
  // Let the lifecycle owner decide: a disconnected VM may report stopped
  // while its processes are still running.
  try {
    await agntPauseWorkspace(workspace.provider_workspace_id, {
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
    });
  } catch (err) {
    if (isDeusError(err) && err.code === "WORKSPACE_STARTING") {
      throw new ConflictError(
        "The cloud computer is still starting. Try archiving it once it is ready."
      );
    }
    throw err;
  }
}

/** Platform-truth status of the sandbox ("paused" | "stopped" | "running" | ...), null if unreachable. */
async function getCloudWorkspaceStatus(
  workspace: CloudWorkspaceRef & { provider_workspace_id: string }
): Promise<string | null> {
  const config = cloudOrgOf(workspace);
  if (!config) return null;
  try {
    const summary = await agntGetWorkspace(workspace.provider_workspace_id, {
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
export async function refreshWorkspaceGithubToken(
  workspace: CloudWorkspaceRef & { repository_id: string | null }
): Promise<boolean> {
  if (!workspace.repository_id) return false;
  // The workspace's own organization: its environment, its secrets and the
  // GitHub App installation token are all that organization's.
  const config = cloudOrgOf(workspace);
  // Only the AGNT config gates this function: the deus-cloud session bits
  // gate the MINT, and mintRepoInstallationToken already no-ops to null
  // without them — the tokenless re-create (public repos, org-PAT setups,
  // env-key-only configs) must still run, because it is ALSO the restart
  // vehicle for stopped sandboxes.
  if (!config) return false;
  const originUrl = getRepositoryById(getDatabase(), workspace.repository_id)?.git_origin_url;
  if (!originUrl) return false;
  const generationAtStart = getCloudIdentityGeneration();
  const envInfo = await getCloudEnvironmentInfo(originUrl, config.orgId);
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
    const repositoryAuth = await refreshEnvironmentGithubTokenOnce(
      originUrl,
      envInfo.environmentId,
      config
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
        repositoryAuth: repositoryAuth ?? undefined,
      });
      // A secret write that failed leaves the platform resolving the OLD
      // token: the re-create still restarts a stopped sandbox, but it is no
      // mint — the next connect must try again.
      // A mark describes THIS identity's token: an account switch while the
      // re-create was in flight must not leave the next identity trusting it.
      if (repositoryAuth && generationAtStart === getCloudIdentityGeneration()) {
        markWorkspaceTokenRefreshed(workspace.provider_workspace_id);
      }
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
  const mint = await mintRepoInstallationToken(originUrl, config.orgId);
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
    // AGNT restores the existing workspace's saved recipe, including project,
    // repository and simulator settings. This call only refreshes credentials.
    environment: mint.token
      ? Environment.from("agnt-base").simulator().secrets({ github_token: mint.token })
      : Environment.from("agnt-base").simulator(),
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    repositoryAuth: mint.token
      ? { type: "github_app" }
      : mint.definitive
        ? { type: "secret" }
        : undefined,
  });
  setInlineMintStamp(workspace, mint.token ? Date.now() : 0);
  if (generationAtStart === getCloudIdentityGeneration()) {
    markWorkspaceTokenRefreshed(workspace.provider_workspace_id);
  }
  return true;
}

/** An App installation token lives an hour; past this age it is treated as
 *  stale and re-minted before a connect that may wake the sandbox. */
const MINT_FRESH_MS = 50 * 60_000;

/** Per provider workspace: when this process last refreshed the token
 *  successfully (any lane — the send and wake paths mark it too, so the
 *  connect that follows them does not repeat the work), and the refresh in
 *  flight, which concurrent connects await rather than proceed past. */
const tokenRefreshMarks = new Map<string, number>();
const tokenRefreshFlights = new Map<string, Promise<boolean>>();

/** A successful re-create (either lane) counts as a mint for the connect hook. */
function markWorkspaceTokenRefreshed(providerWorkspaceId: string): void {
  tokenRefreshMarks.set(providerWorkspaceId, Date.now());
}

/** Whether a token minted at `mintedAt` (null = never stamped) or last
 *  refreshed at `refreshedAt` is still young enough to skip a re-mint. */
export function isMintFresh(
  mintedAt: number | null,
  refreshedAt: number | undefined,
  now: number,
  freshMs: number = MINT_FRESH_MS
): boolean {
  const last = Math.max(refreshedAt ?? 0, mintedAt ?? 0);
  return last > 0 && now - last < freshMs;
}

/**
 * The pre-connect refresh: re-mint the workspace's GitHub token when the last
 * mint is older than the token's useful life. A plain connect wakes a paused
 * sandbox on the platform (session registration resumes it), and a sandbox
 * the provider discarded meanwhile is reprovisioned from the DO's stored map
 * — with the token that map holds. The refresh is the same idempotent
 * re-create the wake and send paths use: a no-op for a running sandbox, a
 * fresh clone with a fresh token for a gone one. Off the hot path by the age
 * check. A connect that finds a refresh in flight WAITS for it — proceeding
 * would register the session, and the registration is what wakes the
 * sandbox. A refresh that did not re-create (a lookup blip, an identity
 * change, an indeterminate mint) leaves no mark: the next connect retries.
 */
export async function refreshWorkspaceGithubTokenIfStale(
  workspaceId: string,
  /** A caller that comes back on its own schedule (the direct-token route's
   *  48-minute renewal) passes the window it can guarantee, so a mint that
   *  would expire before its next visit is refreshed now. */
  freshMs: number = MINT_FRESH_MS
): Promise<void> {
  const row = getDatabase()
    .prepare(
      "SELECT kind, repository_id, provider_workspace_id, organization_id, last_inline_mint_at FROM workspaces WHERE id = ?"
    )
    .get(workspaceId) as
    | {
        kind?: string;
        repository_id?: string | null;
        provider_workspace_id?: string | null;
        organization_id?: string | null;
        last_inline_mint_at?: number | null;
      }
    | undefined;
  if (!row || row.kind !== "cloud" || !row.provider_workspace_id) return;
  const id = row.provider_workspace_id;
  if (
    isMintFresh(row.last_inline_mint_at ?? null, tokenRefreshMarks.get(id), Date.now(), freshMs)
  ) {
    return;
  }
  const inFlight = tokenRefreshFlights.get(id);
  if (inFlight) {
    await inFlight;
    return;
  }
  const flight = refreshWorkspaceGithubToken({
    repository_id: row.repository_id ?? null,
    provider_workspace_id: id,
    organization_id: row.organization_id ?? null,
  }).finally(() => {
    if (tokenRefreshFlights.get(id) === flight) tokenRefreshFlights.delete(id);
  });
  tokenRefreshFlights.set(id, flight);
  await flight;
}

setCloudConnectHook(refreshWorkspaceGithubTokenIfStale);

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

const githubTokenRefreshes = new Map<string, Promise<RepositoryAuth | null>>();

/** Explicit wake releases the platform hold; the runtime owns resume and recovery. */
export async function wakeCloudWorkspaceWithFeedback(workspace: {
  id: string;
  provider_workspace_id: string;
  current_session_id: string | null;
  repository_id?: string | null;
  organization_id?: string | null;
}): Promise<{ ok: boolean; status: string; error?: string }> {
  const db = getDatabase();
  const sessionId = workspace.current_session_id;
  const announce = (data: Record<string, unknown>) => {
    if (sessionId) announceCloudEnv(workspace.id, sessionId, data);
  };
  const setStage = (stage: string | null) => {
    db.prepare("UPDATE workspaces SET init_stage = ? WHERE id = ?").run(stage, workspace.id);
    invalidate(["workspaces"], {});
  };

  const isServing = () => {
    if (!sessionId || !hasLiveCloudSession(sessionId)) return false;
    const row = db
      .prepare("SELECT state, init_stage FROM workspaces WHERE id = ?")
      .get(workspace.id) as { state: string; init_stage: string | null } | undefined;
    return row?.state === "ready" && (row.init_stage === null || row.init_stage === "running");
  };

  const status = await getCloudWorkspaceStatus(workspace);
  // HTTP status can fail while the existing session still serves the computer.
  // A channel alone is insufficient: it also stays open while the VM sleeps.
  const refreshing = status === "running" || (status === null && isServing());
  if (status === "running") {
    // An earlier wake may have succeeded despite a lost response. An online
    // resume is a no-op, so no later frame is guaranteed to clear stale sleep.
    setStage(null);
  } else if (!refreshing) {
    setStage("resuming");
    announce({ status: "resuming" });
  }
  // Legacy workspaces may still carry a desktop-minted token. Refresh it when
  // possible, but cloud-owned renewal must also work without a desktop session.
  try {
    await refreshWorkspaceGithubToken({
      repository_id: workspace.repository_id ?? null,
      provider_workspace_id: workspace.provider_workspace_id,
      organization_id: workspace.organization_id ?? null,
    });
  } catch (err) {
    console.warn(`[WORKSPACE] legacy GitHub refresh unavailable: ${err}`);
  }
  try {
    await resumeCloudWorkspace(workspace);
  } catch (err) {
    console.warn(`[WORKSPACE] cloud wake failed: ${err}`);
    if (refreshing && isServing()) return { ok: false, status: "running" };
    const failedStatus = status === "paused" || status === "stopped" ? status : "error";
    setStage(failedStatus);
    const error =
      err instanceof Error ? err.message : "Could not wake the cloud machine. Try again.";
    announce({ status: failedStatus, reason: error });
    return { ok: false, status: failedStatus, error };
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
  invalidate(["workspaces"], {});
  return { ok: true, status: status === "running" ? "running" : "resuming" };
}

/** Release an explicit pause and resume the retained VM. */
export async function resumeCloudWorkspace(
  workspace: CloudWorkspaceRef & { provider_workspace_id: string }
): Promise<void> {
  if (!cloudAccount()) throw new ValidationError("Cloud workspaces are not configured");
  const config = requireCloudOrg(workspace.organization_id);
  await agntResumeWorkspace(workspace.provider_workspace_id, {
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
  });
}

/**
 * Connection and repository access in one organization (the default when
 * omitted); provider accounts have their own personal API.
 */
export async function getCloudSettingsStatus(organizationId?: string | null): Promise<{
  enabled: boolean;
  baseUrl: string | null;
  hasGithubToken: boolean;
}> {
  const config = cloudOrg(organizationId);
  if (!config) return { enabled: false, baseUrl: null, hasGithubToken: false };
  let hasGithubToken = false;
  try {
    for await (const secret of agntListSecrets({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
    })) {
      // Environment-scoped GitHub App mints expire; only an org-wide token
      // counts as the user's saved PAT.
      if (secret.name.toLowerCase() === "github_token" && secret.appliesToAll !== false) {
        hasGithubToken = true;
        break;
      }
    }
  } catch (err) {
    console.warn(`[CloudSettings] listSecrets failed: ${err instanceof Error ? err.message : err}`);
  }
  return { enabled: true, baseUrl: config.baseUrl, hasGithubToken };
}

/** Store the org github_token secret (unlocks private repos in sandboxes). */
export async function saveCloudGithubToken(
  token: string,
  organizationId?: string | null
): Promise<void> {
  if (!cloudAccount()) throw new ValidationError("Cloud workspaces are not configured");
  const config = requireCloudOrg(organizationId);
  await agntCreateSecret("github_token", token, {
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    appliesToAll: true,
  });
}

/** The App grant path is only usable when a deus-cloud session is configured. */
function isGrantPathConfigured(orgId: string | null): boolean {
  const c = cloudAccount();
  return !!(c?.deusCloudUrl && c.sessionToken && orgId);
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
  mint: { token: string | null; definitive: boolean },
  orgId: string | null,
  fresh = false
): Promise<CloudRepoAccessStatus> {
  if (mint.token) return "ok";
  const isPublic = await isPublicGithubRepo(slug, { fresh });
  if (isPublic) return "ok";
  if (isPublic === null) return "unknown"; // probe couldn't tell → never block
  // isPublic === false: provably not anonymously cloneable. Emit needs_grant
  // ONLY when the App IS the configured grant path — a definitive mint without
  // a deus-cloud session just means "no App configured" (an env-key / org-PAT
  // setup that clones private repos via the org PAT server-side), so prompting
  // to install an App that isn't in use would dead-end AND wrongly block a
  // create that succeeds via the PAT. That stays "unknown".
  if (mint.definitive && isGrantPathConfigured(orgId)) return "needs_grant";
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
export async function resolveCloudRepoAccess(
  repoId: string,
  /** The organization the workspace would run in; the default when omitted. */
  organizationId?: string | null,
  /** Ask again rather than reuse a recent answer: the gate is waiting for a grant. */
  { fresh = false }: { fresh?: boolean } = {}
): Promise<CloudRepoAccess> {
  const org = cloudOrg(organizationId);
  if (!org) return { status: "unknown", slug: null };
  const originUrl = getRepositoryById(getDatabase(), repoId)?.git_origin_url;
  if (!originUrl) return { status: "unknown", slug: null };
  const slug = githubRepoSlug(originUrl);
  if (!slug) return { status: "unknown", slug: null };
  const mint = await mintRepoInstallationToken(originUrl, org.orgId, { fresh });
  return { status: await classifyRepoAccess(slug, mint, org.orgId, fresh), slug };
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
/** Best-effort: the workspace still provisions without device support, and
 *  Start then says so. Enabling twice is harmless. */
async function enableEnvironmentSimulator(
  environmentId: string,
  orgId: string | null
): Promise<void> {
  try {
    await enableCloudEnvironmentSimulator(environmentId, orgId);
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
  org: CloudOrg
): Promise<RepositoryAuth | null> {
  // Normalized key: provisioning passes the https form, wake/send pass the
  // raw stored origin — an ssh-form remote would otherwise key two separate
  // flights for the same environment and re-open the delete-vs-write race
  // the single-flight exists to close. Keyed by organization too: the same
  // repository has a different environment, and a different installation
  // token, in each organization; sharing a flight would hand one
  // organization's token to the other.
  const key = JSON.stringify([org.orgId, httpsOrigin(originUrl)]);
  const inFlight = githubTokenRefreshes.get(key);
  if (inFlight) return inFlight;
  const run: Promise<RepositoryAuth | null> = refreshEnvironmentGithubToken(
    originUrl,
    environmentId,
    org
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
  tokenRefreshMarks.clear();
  tokenRefreshFlights.clear();
  githubTokenRefreshes.clear();
}

async function refreshEnvironmentGithubToken(
  originUrl: string,
  environmentId: string,
  org: CloudOrg
): Promise<RepositoryAuth | null> {
  const { baseUrl, apiKey } = org;
  const mint = await mintRepoInstallationToken(originUrl, org.orgId);
  try {
    if (mint.token) {
      await agntCreateSecret("github_token", mint.token, {
        baseUrl,
        apiKey,
        environmentIds: [environmentId],
        appliesToAll: false,
      });
      return { type: "github_app" };
    }
    // Delete the stored env token when deus-cloud POSITIVELY said this
    // identity may not mint — or when the stored token is provably PAST its
    // one-hour life. An unknown outcome keeps a token only while it can
    // still work: an expired scoped token is pure downside (it shadows the
    // org PAT while authenticating nothing), so age decides where the mint
    // couldn't.
    const keepUnknown = !mint.definitive;
    for await (const secret of agntListSecrets({ baseUrl, apiKey })) {
      if (secret.name.toLowerCase() !== "github_token") continue;
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
        // Kept, not minted: nothing here may count as fresh.
        if (stillPlausiblyValid) return null;
      }
      await agntDeleteSecret(secret.id, { baseUrl, apiKey });
      break;
    }
    return mint.definitive ? { type: "secret" } : null;
  } catch (err) {
    // Best-effort, exactly like the inline path: a PAT (or a public repo)
    // still works, and the failure must not block provisioning or a wake.
    // Reported as not written, so nothing counts it as a fresh mint.
    console.warn(`[CloudInit] environment-scoped GitHub token refresh failed: ${err}`);
    return null;
  }
}

async function provisionInBackground(
  workspaceId: string,
  originUrl: string,
  branch: { source: string; work: string },
  org: CloudOrg
): Promise<void> {
  const db = getDatabase();
  const identity = getCloudIdentitySignal();
  const { baseUrl, apiKey } = org;
  try {
    const userId = await getCloudWorkspaceUserId(org.orgId);
    identity.throwIfAborted();
    // A specialized environment (agent-authored via agnt_configure_environment,
    // resolved by the derived repo name) wins; absence of one IS the default —
    // the inline recipe below, exactly as before.
    const envInfo = await getCloudEnvironmentInfo(originUrl, org.orgId);
    identity.throwIfAborted();
    if (envInfo.lookupFailed)
      throw new Error(
        "Could not load project settings. Try again when the cloud connection is available."
      );
    let environment: string | ReturnType<typeof Environment.from>;
    let inlineMintStampAtCreate: number | null = null;
    // Named lane: whether the environment-scoped token landed before create —
    // then the connect that follows provisioning has nothing to re-mint.
    let repositoryAuth: RepositoryAuth | undefined;
    if (envInfo.environmentId) {
      // Named environments resolve their secrets FROM THE PLATFORM — the create
      // API rejects inline secrets alongside an environmentId — so the App
      // token cannot ride the request here. Without this, a repo that has been
      // through environment setup silently loses App access: the first
      // (inline) workspace clones fine, every later one clones anonymously and
      // fails on a private repo. So write the mint as an environment-scoped
      // secret just before create; agnt resolves it by environment id.
      repositoryAuth =
        (await refreshEnvironmentGithubTokenOnce(originUrl, envInfo.environmentId, org)) ??
        undefined;
      identity.throwIfAborted();
      // Every cloud workspace shows a Simulator tab; an environment saved
      // before devices existed cannot honour it, and the recipe is captured
      // at create — so upgrade the environment FIRST (enabling is free:
      // billing starts with a device). Best-effort: the workspace still
      // provisions without it, and Start then says so.
      if (envInfo.simulator === false) {
        await enableEnvironmentSimulator(envInfo.environmentId, org.orgId);
      }
      // Adding a personal secret scope must not select a same-name personal recipe.
      environment = envInfo.environmentId;
    } else {
      // Every inline cloud workspace can host a device (the Simulator tab):
      // `.simulator()` only ENABLES it — billing starts when a device starts,
      // so the flag is free until the tab is used. Named environments (above)
      // are the agent's own config and are left alone.
      let recipe = Environment.from("agnt-base")
        .project()
        .repo(originUrl, branch.source)
        .simulator();
      // Per-repo App token (short-lived, this repo only) rides as a request
      // secret: it drives agnt's git-auth step and NEVER lands in pg — the
      // DO refreshes secrets on every ensure, so each provision gets a
      // fresh mint instead of replaying a stale one.
      const mint = await mintRepoInstallationToken(originUrl, org.orgId);
      identity.throwIfAborted();
      repositoryAuth = mint.token
        ? { type: "github_app" }
        : mint.definitive
          ? { type: "secret" }
          : undefined;
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
        if (slug && (await classifyRepoAccess(slug, mint, org.orgId)) === "needs_grant") {
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
    identity.throwIfAborted();
    const provider = await agntCreateWorkspace({
      baseUrl,
      apiKey,
      userId,
      environment,
      repositoryAuth,
      // New branch off the source — the sandbox's whole life happens here.
      checkout: { branch: branch.work, from: branch.source },
    });
    db.prepare(
      "UPDATE workspaces SET provider_workspace_id = ?, init_stage = 'creating cloud session', last_inline_mint_at = ? WHERE id = ?"
    ).run(provider.id, inlineMintStampAtCreate, workspaceId);
    if (repositoryAuth) markWorkspaceTokenRefreshed(provider.id);
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
      // Keep the failed stage as diagnostic context alongside the specific error.
      "UPDATE workspaces SET state = 'error', error_message = ? WHERE id = ?"
    ).run(`Cloud provisioning failed: ${message}`, workspaceId);
    invalidate([...WORKSPACE_RESOURCES], {});
  }
}
