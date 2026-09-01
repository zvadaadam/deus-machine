import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { toast } from "sonner";
import {
  mapToRepoGroups,
  toSession,
  cloudDataRequestInterceptor,
  bustCloudSessionsListCache,
  CloudSessionExpiredError,
} from "@/features/session/cloud/cloudDataAdapter";
import { handleWebCloudSessionExpired } from "@/features/session/cloud/webCloudDirectConfig";

// Partial discovery failures surface through sonner; node-env has no toaster.
vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn() } }));
// The 401 path re-authenticates through window.location, absent here — the
// contract under test is that it is CALLED, not where it navigates.
vi.mock("@/features/session/cloud/webCloudDirectConfig", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/session/cloud/webCloudDirectConfig")>()),
  handleWebCloudSessionExpired: vi.fn(),
}));

const agntSession = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "sess_1",
  status: "running",
  workspace_id: "ws_1",
  workspace_status: "running",
  sandbox_id: "sb_1",
  title: "Fix the bug",
  repo: "acme/app",
  branch: "main",
  created_at: "2026-08-30T00:00:00Z",
  updated_at: "2026-08-31T00:00:00Z",
  ...over,
});

type Groups = ReturnType<typeof mapToRepoGroups>;

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const fail = (status: number) => ({ ok: false, status, json: async () => ({}) });

/** fetch routed by path — per-org lists resolve concurrently, so call ORDER is not a contract. */
function routeFetch(routes: Record<string, () => unknown>) {
  const fetchMock = vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    const route = routes[path];
    if (!route) throw new Error(`unexpected fetch ${path}`);
    return route();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function stubBearer() {
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => (k === "deus_cloud_session" ? "the.bearer.jwt" : null),
    setItem: () => {},
    removeItem: () => {},
  } as unknown as Storage);
}

beforeEach(() => {
  // The 3s in-flight cache would otherwise hand one test's list to the next.
  bustCloudSessionsListCache();
});

describe("mapToRepoGroups", () => {
  it("groups sessions by repo and maps each to a cloud workspace item", () => {
    const groups = mapToRepoGroups([
      agntSession({ id: "a", repo: "acme/app" }),
      agntSession({ id: "b", repo: "acme/app" }),
      agntSession({ id: "c", repo: "acme/api" }),
    ] as never);
    expect(groups).toHaveLength(2);
    const app = groups.find((g) => g.repo_name === "acme/app")!;
    expect(app.workspaces.map((w) => w.id)).toEqual(["a", "b"]);
    const w = app.workspaces[0];
    expect(w).toMatchObject({
      id: "a",
      kind: "cloud",
      current_session_id: "a", // opening the item opens this session
      provider_workspace_id: "ws_1",
      repo_name: "acme/app",
      session_status: "working", // agnt "running" → deus "working"
    });
  });

  it("falls back to a 'Cloud' group when the workspace has no repo", () => {
    const groups = mapToRepoGroups([agntSession({ repo: null })] as never);
    expect(groups[0].repo_name).toBe("Cloud");
  });

  it("does not echo the title into the slug (the sidebar's secondary line)", () => {
    const [titled] = mapToRepoGroups([agntSession({ branch: "feat/x" })] as never);
    expect(titled.workspaces[0].slug).toBe("feat/x");
    const [untitled] = mapToRepoGroups([
      agntSession({ id: "abcdef0123", title: null, branch: null }),
    ] as never);
    expect(untitled.workspaces[0].slug).toBe("abcdef01");
  });
});

describe("toSession", () => {
  it("maps an agnt session to the detail the direct lane reads", () => {
    expect(toSession(agntSession({ id: "x", status: "ready" }) as never)).toMatchObject({
      id: "x",
      provider_session_id: "x", // id IS the provider id — drives useIsDirectSession
      workspace_kind: "cloud",
      status: "idle", // agnt "ready" → deus "idle"
      agent_harness: "claude-code",
    });
  });

  it("maps agnt statuses: running→working, error→error, else→idle", () => {
    expect(toSession(agntSession({ status: "running" }) as never).status).toBe("working");
    expect(toSession(agntSession({ status: "error" }) as never).status).toBe("error");
    expect(toSession(agntSession({ status: "paused" }) as never).status).toBe("idle");
    expect(toSession(agntSession({ status: "provisioning" }) as never).status).toBe("idle");
  });
});

describe("cloudDataRequestInterceptor", () => {
  beforeEach(() => {
    stubBearer();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns null for resources it does not own (falls through to the socket)", () => {
    expect(cloudDataRequestInterceptor("messages", { sessionId: "s" })).toBeNull();
    expect(cloudDataRequestInterceptor("unknown")).toBeNull();
  });

  it("stubs 'settings' so the shell boot-gate mounts (onboarding already done)", async () => {
    await expect(cloudDataRequestInterceptor("settings")).resolves.toEqual({
      onboarding_completed: true,
    });
  });

  it("routes 'workspaces' to agnt and maps the result to RepoGroup[]", async () => {
    const fetchMock = vi
      .fn()
      // GET /dashboard/orgs
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ items: [{ id: "org_1" }] }),
      })
      // GET /dashboard/orgs/org_1/sessions
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ items: [agntSession({ id: "s1", repo: "acme/app" })] }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const groups = (await cloudDataRequestInterceptor("workspaces")) as Groups;
    expect(groups[0].repo_name).toBe("acme/app");
    expect(groups[0].workspaces[0].id).toBe("s1");
    // Bearer rode the request.
    expect(fetchMock.mock.calls[0][1].headers.authorization).toBe("Bearer the.bearer.jwt");
  });
});

describe("multi-org discovery", () => {
  const twoOrgs = () => ok({ items: [{ id: "org_1" }, { id: "org_2" }] });
  const org1Sessions = () => ok({ items: [agntSession({ id: "s1", repo: "acme/app" })] });

  beforeEach(() => {
    stubBearer();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(toast.error).mockClear();
    vi.mocked(handleWebCloudSessionExpired).mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps the orgs that answered when one fails, and says so once per outage", async () => {
    const outage = {
      "/dashboard/orgs": twoOrgs,
      "/dashboard/orgs/org_1/sessions": org1Sessions,
      "/dashboard/orgs/org_2/sessions": () => fail(500),
    };
    routeFetch(outage);
    const groups = (await cloudDataRequestInterceptor("workspaces")) as Groups;
    expect(groups.flatMap((g) => g.workspaces.map((w) => w.id))).toEqual(["s1"]);
    expect(console.warn).toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't load sessions for one of your organizations"
    );

    // The next discovery tick during the same outage stays quiet.
    bustCloudSessionsListCache();
    await cloudDataRequestInterceptor("workspaces");
    expect(toast.error).toHaveBeenCalledTimes(1);

    // Recovery re-arms the notice for the next outage.
    bustCloudSessionsListCache();
    routeFetch({ ...outage, "/dashboard/orgs/org_2/sessions": () => ok({ items: [] }) });
    await cloudDataRequestInterceptor("workspaces");
    bustCloudSessionsListCache();
    routeFetch(outage);
    await cloudDataRequestInterceptor("workspaces");
    expect(toast.error).toHaveBeenCalledTimes(2);

    // Leave the latch re-armed for the suites that follow.
    bustCloudSessionsListCache();
    routeFetch({ ...outage, "/dashboard/orgs/org_2/sessions": () => ok({ items: [] }) });
    await cloudDataRequestInterceptor("workspaces");
  });

  it("still propagates an auth failure from any org as session-expired", async () => {
    routeFetch({
      "/dashboard/orgs": twoOrgs,
      "/dashboard/orgs/org_1/sessions": org1Sessions,
      "/dashboard/orgs/org_2/sessions": () => fail(401),
    });
    await expect(cloudDataRequestInterceptor("workspaces")).rejects.toBeInstanceOf(
      CloudSessionExpiredError
    );
    expect(handleWebCloudSessionExpired).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("warns when the server capped a list (has_more) rather than cutting silently", async () => {
    routeFetch({
      "/dashboard/orgs": () => ok({ items: [{ id: "org_1" }] }),
      "/dashboard/orgs/org_1/sessions": () =>
        ok({ items: [agntSession({ id: "s1" })], has_more: true }),
    });
    const groups = (await cloudDataRequestInterceptor("workspaces")) as Groups;
    expect(groups[0].workspaces).toHaveLength(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("has_more"));
    expect(toast.error).not.toHaveBeenCalled();
  });
});
