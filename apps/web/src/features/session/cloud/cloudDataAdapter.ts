// apps/web/src/features/session/cloud/cloudDataAdapter.ts
// The fully-Mac-closed WEB data source.
//
// A browser with no Mac backend can't answer `q:request`, so the sidebar and
// session-detail reads come from agnt's dashboard REST instead. This maps agnt's
// session/workspace rows onto the SAME `RepoGroup[]` / `Session` shapes the deus
// UI already renders, and registers itself as the platform-ws request
// interceptor — but ONLY in web-direct mode (`installCloudDataAdapter` is a no-op
// otherwise, so every backed build is untouched).
//
// Session MESSAGES are NOT served here: in direct mode the agnt socket folds them
// into the message cache (see cloudFrameHandler). This adapter is discovery +
// metadata only — "which sessions exist, and what does this one look like".

import type { RepoGroup, Workspace } from "@shared/types/workspace";
import type { Session } from "@shared/types/session";
import type { SessionStatus, WorkspaceState } from "@shared/enums";
import { toast } from "sonner";
import { setQueryRequestInterceptor } from "@/platform/ws";
import { queryClient } from "@/shared/api/queryClient";
import {
  resolveAgntBaseUrl,
  readWebCloudSessionBearer,
  isCloudDirectWebMode,
  handleWebCloudSessionExpired,
} from "./webCloudDirectConfig";

/** One row of `GET /dashboard/orgs/:orgId/sessions` (snake_case on the wire). */
interface AgntSession {
  id: string;
  status: string;
  workspace_id: string;
  workspace_status: string;
  sandbox_id: string | null;
  title: string | null;
  repo: string | null;
  branch: string | null;
  /** The engine the session runs (from its create-time metadata); absent on
   *  rows created before the harness was stamped. */
  harness?: string | null;
  created_at: string;
  updated_at: string;
}

const KNOWN_HARNESSES = new Set(["claude-code", "codex-sdk", "codex-app-server"]);

/** Discovery's harness, defended to the enum — legacy rows default to claude. */
function mapHarness(harness: string | null | undefined): import("@/shared/agents").AgentHarness {
  return (
    harness && KNOWN_HARNESSES.has(harness) ? harness : "claude-code"
  ) as import("@/shared/agents").AgentHarness;
}

/** A 401 from agnt — the deus_cloud_session lapsed; the caller re-triggers login. */
export class CloudSessionExpiredError extends Error {
  constructor() {
    super("Your Deus Cloud session expired — sign in again");
    this.name = "CloudSessionExpiredError";
  }
}

// ---- agnt REST ----

async function dashboardGet<T>(path: string): Promise<T> {
  const bearer = await readWebCloudSessionBearer();
  if (!bearer) throw new CloudSessionExpiredError();
  const res = await fetch(`${resolveAgntBaseUrl()}${path}`, {
    headers: { authorization: `Bearer ${bearer}` },
  });
  if (res.status === 401) throw new CloudSessionExpiredError();
  if (!res.ok) throw new Error(`agnt ${path} failed (${res.status})`);
  return (await res.json()) as T;
}

/**
 * agnt's list envelope. `has_more` flags the server-side cap — a cursor is the
 * follow-up there; until then the cut must at least never be silent here.
 */
interface DashboardList<T> {
  items?: T[];
  has_more?: boolean;
}

// One notice per outage, not one per discovery tick: latched until a fully
// successful fetch re-arms it.
let orgFailureNoticed = false;

async function fetchAllCloudSessions(): Promise<AgntSession[]> {
  const orgs = await dashboardGet<DashboardList<{ id: string }>>("/dashboard/orgs");
  if (orgs.has_more) {
    console.warn(
      "[cloudDataAdapter] /dashboard/orgs truncated (has_more) — sessions in the orgs past the cap are not listed"
    );
  }
  const results = await Promise.allSettled(
    (orgs.items ?? []).map(async (org) => {
      const page = await dashboardGet<DashboardList<AgntSession>>(
        `/dashboard/orgs/${encodeURIComponent(org.id)}/sessions`
      );
      if (page.has_more) {
        console.warn(
          `[cloudDataAdapter] org ${org.id} has more sessions than the server cap (has_more) — older ones are not listed`
        );
      }
      return page.items ?? [];
    })
  );
  // One org failing must not blank the others. An auth failure is not "one
  // org", though — the bearer is dead for all of them — so it propagates.
  const sessions: AgntSession[] = [];
  let failed = 0;
  for (const result of results) {
    if (result.status === "fulfilled") {
      sessions.push(...result.value);
      continue;
    }
    if (result.reason instanceof CloudSessionExpiredError) throw result.reason;
    failed += 1;
    console.warn("[cloudDataAdapter] org session list failed:", result.reason);
  }
  if (failed === 0) {
    orgFailureNoticed = false;
  } else if (!orgFailureNoticed) {
    orgFailureNoticed = true;
    toast.error("Couldn't load sessions for one of your organizations");
  }
  return sessions;
}

// A short in-flight cache so the near-simultaneous "workspaces" (sidebar) and
// "session" (open panel) reads share one round-trip. TTL is tiny — freshness
// comes from re-fetch on focus/interval, not from holding this.
const LIST_TTL_MS = 3000;
let listCache: { at: number; promise: Promise<AgntSession[]> } | null = null;

/**
 * Drop the in-flight list cache so the NEXT read hits agnt. Event-driven
 * refreshes (turn boundaries) call this before invalidating — inside the TTL
 * they'd otherwise refetch the cached list and see the pre-event status.
 */
export function bustCloudSessionsListCache(): void {
  listCache = null;
}

function getCloudSessions(): Promise<AgntSession[]> {
  const now = Date.now();
  if (listCache && now - listCache.at < LIST_TTL_MS) return listCache.promise;
  const promise = fetchAllCloudSessions().catch((err) => {
    listCache = null; // don't cache a failure
    throw err;
  });
  listCache = { at: now, promise };
  return promise;
}

// ---- mapping: agnt canonical status → deus vocabulary ----

function mapSessionStatus(agnt: string): SessionStatus {
  // agnt: provisioning | ready | running | paused | stopped | error
  if (agnt === "running") return "working";
  if (agnt === "error") return "error";
  return "idle";
}

function mapWorkspaceState(agnt: string): WorkspaceState {
  // agnt workspace: provisioning | running | paused | stopped | error | deleted
  if (agnt === "provisioning") return "initializing";
  if (agnt === "error") return "error";
  if (agnt === "deleted") return "archived";
  return "ready";
}

function repoLabel(repo: string | null): string {
  return repo ?? "Cloud";
}

/**
 * agnt workspace statuses that `cloudPresence` parks on (asleep / waking).
 * The Mac driver mirrors these into `init_stage`; discovery must do the same
 * or a paused sandbox presents as awake — the wake affordance hides and the
 * Files/Changes/Terminal panels fire at a sidecar that isn't running.
 */
function parkedInitStage(workspaceStatus: string): string | null {
  return workspaceStatus === "paused" ||
    workspaceStatus === "stopped" ||
    workspaceStatus === "resuming"
    ? workspaceStatus
    : null;
}

/**
 * Each cloud session presents as its own sidebar item — 1:1 session↔item, keyed
 * by the agnt session id (which is also the provider session id the direct lane
 * connects to). Worktree-only fields (root_path, git worktree, PR) are
 * nulled/empty: a cloud sandbox has no local checkout.
 */
function toWorkspace(s: AgntSession): Workspace {
  return {
    id: s.id,
    repository_id: repoLabel(s.repo),
    // Not the title: under a titled row the sidebar shows `slug` as the
    // secondary line, where it would just repeat the title. The branch is
    // real context; the id prefix keeps untitled rows labelled.
    slug: s.branch ?? s.id.slice(0, 8),
    title: s.title,
    git_branch: s.branch,
    git_target_branch: null,
    kind: "cloud",
    provider_workspace_id: s.workspace_id,
    state: mapWorkspaceState(s.workspace_status),
    status: "in-progress",
    current_session_id: s.id,
    session_status: mapSessionStatus(s.status),
    session_error_category: null,
    session_error_message: null,
    latest_message_sent_at: s.updated_at,
    updated_at: s.updated_at,
    repo_name: repoLabel(s.repo),
    root_path: "",
    workspace_path: "",
    setup_status: "completed",
    init_stage: parkedInitStage(s.workspace_status),
    error_message: null,
  };
}

export function mapToRepoGroups(agntSessions: AgntSession[]): RepoGroup[] {
  const byRepo = new Map<string, Workspace[]>();
  for (const s of agntSessions) {
    const repo = repoLabel(s.repo);
    let group = byRepo.get(repo);
    if (!group) {
      group = [];
      byRepo.set(repo, group);
    }
    group.push(toWorkspace(s));
  }
  return [...byRepo.entries()].map(([repo, workspaces], index) => ({
    repo_id: repo,
    repo_name: repo,
    sort_order: index,
    workspaces,
  }));
}

/** The session-detail shape the direct lane + header read (drives useIsDirectSession). */
export function toSession(s: AgntSession): Session {
  return {
    id: s.id,
    workspace_id: s.workspace_id,
    agent_harness: mapHarness(s.harness),
    provider_session_id: s.id,
    workspace_kind: "cloud",
    title: s.title,
    status: mapSessionStatus(s.status),
    // Discovery carries no count, but the chat tabs hydrate ONCE from this row
    // and label `message_count === 0` "New chat" — a title is only ever minted
    // after the first turn, so it's an honest has-started proxy. The real count
    // lands on `sessions.detail` when the socket snapshot arrives.
    message_count: s.title ? 1 : 0,
    context_token_count: 0,
    context_used_percent: 0,
    is_hidden: false,
    last_user_message_at: s.updated_at,
    updated_at: s.updated_at,
  };
}

// ---- the interceptor ----

/**
 * Serve the deus frontend's read resources from agnt in web-direct mode. Returns
 * a promise for a resource it owns, or null to fall through to the (absent) WS —
 * MESSAGES intentionally falls through: the direct socket folds them, and a
 * direct session's Mac message-lane is disabled anyway.
 */
export function cloudDataRequestInterceptor(
  resource: string,
  params?: Record<string, unknown>
): Promise<unknown> | null {
  switch (resource) {
    case "workspaces":
      return withAuthGuard(getCloudSessions().then(mapToRepoGroups));
    case "session": {
      const sessionId = params?.sessionId as string | undefined;
      if (!sessionId) return null;
      return withAuthGuard(
        getCloudSessions().then((list) => {
          const found = list.find((s) => s.id === sessionId);
          if (!found) throw new Error("Session not found");
          return toSession(found);
        })
      );
    }
    case "sessions": {
      // Sessions for a workspace (the chat-tab list). 1:1 here, so it's the
      // single session whose id === the workspace item id.
      const workspaceId = params?.workspaceId as string | undefined;
      return withAuthGuard(
        getCloudSessions().then((list) =>
          list.filter((s) => s.id === workspaceId || s.workspace_id === workspaceId).map(toSession)
        )
      );
    }
    case "settings":
      // The shell gates on this q: read; there is no local settings store in
      // web-direct, and the user already onboarded (they signed into Deus Cloud).
      return Promise.resolve({ onboarding_completed: true });
    default:
      // Everything else (messages — folded by the socket; and Mac-only
      // resources) falls through to the transport, which answers honestly that
      // there is no backend. See query-protocol-client's web-direct gating.
      return null;
  }
}

/** On an expired bearer (agnt 401), drop it + re-auth; the error still surfaces. */
function withAuthGuard<T>(promise: Promise<T>): Promise<T> {
  return promise.catch((err) => {
    if (err instanceof CloudSessionExpiredError) handleWebCloudSessionExpired();
    throw err;
  });
}

/**
 * Discovery has no push in web-direct (the q: subscriptions are no-ops), and
 * the workspace/session hooks assume push freshness (`staleTime: Infinity`, no
 * focus refetch) — so without a cadence, a session created on another client or
 * a background status change never appears for the page's lifetime. A modest
 * interval invalidates the discovery-served keys; only ACTIVE queries refetch,
 * and the adapter's in-flight cache coalesces the fan-out to one agnt list call.
 */
const DISCOVERY_REFRESH_MS = 60_000;

function refreshDiscovery(): void {
  void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
  void queryClient.invalidateQueries({ queryKey: ["sessions", "by-workspace"] });
}

function startDiscoveryRefresh(): void {
  // Hidden tabs skip the tick (a backgrounded tab shouldn't poll agnt all
  // day); regaining visibility refreshes immediately, so returning to the tab
  // never waits out the interval. A true push source is the agnt-side
  // follow-up — the dashboard has no event channel to subscribe to yet.
  setInterval(() => {
    if (!document.hidden) refreshDiscovery();
  }, DISCOVERY_REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshDiscovery();
  });
}

/** Register the adapter — a no-op unless this is a fully Mac-closed web build. */
export function installCloudDataAdapter(): void {
  if (!isCloudDirectWebMode()) return;
  setQueryRequestInterceptor(cloudDataRequestInterceptor);
  startDiscoveryRefresh();
}
