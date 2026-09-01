import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mapToRepoGroups,
  toSession,
  cloudDataRequestInterceptor,
} from "@/features/session/cloud/cloudDataAdapter";

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
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => (k === "deus_cloud_session" ? "the.bearer.jwt" : null),
      setItem: () => {},
      removeItem: () => {},
    } as unknown as Storage);
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

    const groups = (await cloudDataRequestInterceptor("workspaces")) as ReturnType<
      typeof mapToRepoGroups
    >;
    expect(groups[0].repo_name).toBe("acme/app");
    expect(groups[0].workspaces[0].id).toBe("s1");
    // Bearer rode the request.
    expect(fetchMock.mock.calls[0][1].headers.authorization).toBe("Bearer the.bearer.jwt");
  });
});
