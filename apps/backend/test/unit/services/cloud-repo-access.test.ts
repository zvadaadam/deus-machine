import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// resolveCloudRepoAccess is the ONE verdict behind both the composer's
// "Grant repository access" modal and the create-time safety net. It layers on
// the real mintRepoInstallationToken + an unauthenticated public probe, so we
// drive it end-to-end through mocked fetch (deus-cloud mint + api.github.com)
// plus the cloud config / repo row.

const { mockGetCloudConfig, mockGetRepositoryById } = vi.hoisted(() => ({
  mockGetCloudConfig: vi.fn(),
  mockGetRepositoryById: vi.fn(),
}));

vi.mock("../../../src/lib/database", () => ({ getDatabase: vi.fn(() => ({})) }));
vi.mock("../../../src/db", () => ({ getRepositoryById: mockGetRepositoryById }));
vi.mock("../../../src/services/query-engine", () => ({ invalidate: vi.fn() }));
vi.mock("../../../src/services/agent/cloud/config", () => ({
  // The workspace-init service registers its pre-connect refresh at import.
  setCloudConnectHook: () => {},
  getCloudConfig: mockGetCloudConfig,
}));
vi.mock("../../../src/services/workspace.service", () => ({ generateUniqueName: vi.fn() }));
vi.mock("../../../src/services/agent/cloud/driver", () => ({
  ensureCloudSession: vi.fn(),
  announceCloudEnv: vi.fn(),
  getCloudIdentityGeneration: vi.fn(() => 0),
}));
vi.mock("../../../src/services/cloud-environment.service", () => ({
  getCloudEnvironmentInfo: vi.fn(),
}));
vi.mock("@deus-hq/sdk", () => ({
  createWorkspace: vi.fn(),
  createSession: vi.fn(),
  stopWorkspace: vi.fn(),
  resumeWorkspace: vi.fn(),
  getWorkspace: vi.fn(),
  createSecret: vi.fn(),
  listSecrets: vi.fn(),
  deleteSecret: vi.fn(),
  Environment: {
    from: vi.fn(() => ({ repo: vi.fn().mockReturnThis(), secrets: vi.fn().mockReturnThis() })),
  },
}));

import { resolveCloudRepoAccess } from "../../../src/services/cloud-workspace-init.service";

const FULL_CONFIG = {
  deusCloudUrl: "https://deus-cloud.test",
  deusCloudSessionToken: "sess-tok",
  orgId: "org-1",
  baseUrl: "https://api.agnt.test",
  apiKey: "agnt_sk",
};
const PRIVATE_ORIGIN = "https://github.com/zvadaadam/therapist-backend";
const SLUG = "zvadaadam/therapist-backend";

const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Route mocked fetch: deus-cloud installation-token (the mint) + the public probe. */
function stubFetch(handlers: { mint?: () => Response; ghApi?: () => Response }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.includes("/github/installation-token"))
        return handlers.mint?.() ?? new Response(null, { status: 500 });
      if (u.includes("api.github.com/repos/"))
        return handlers.ghApi?.() ?? new Response(null, { status: 404 });
      throw new Error(`unexpected fetch: ${u}`);
    })
  );
}

// deus-cloud's own "no installation" answer — the DEFINITIVE no-access signal.
const mintNoInstallation = () =>
  jsonRes(404, { error: "NOT_FOUND", message: "No GitHub App installation for zvadaadam" });

describe("resolveCloudRepoAccess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCloudConfig.mockReturnValue(FULL_CONFIG);
    mockGetRepositoryById.mockReturnValue({ git_origin_url: PRIVATE_ORIGIN });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("unknown when there is no Deus Cloud session (nothing to grant)", async () => {
    mockGetCloudConfig.mockReturnValue(null);
    expect(await resolveCloudRepoAccess("r1")).toEqual({ status: "unknown", slug: null });
  });

  it("unknown for a repo with no origin url", async () => {
    mockGetRepositoryById.mockReturnValue({ git_origin_url: null });
    expect(await resolveCloudRepoAccess("r1")).toEqual({ status: "unknown", slug: null });
  });

  it("unknown for a non-GitHub origin (grant is GitHub-specific)", async () => {
    mockGetRepositoryById.mockReturnValue({ git_origin_url: "https://gitlab.com/team/repo" });
    expect(await resolveCloudRepoAccess("r1")).toEqual({ status: "unknown", slug: null });
  });

  it("ok when the App mints a token (repo is covered)", async () => {
    stubFetch({ mint: () => jsonRes(200, { token: "ghs_installation_x" }) });
    expect(await resolveCloudRepoAccess("r1")).toEqual({ status: "ok", slug: SLUG });
  });

  it("ok for an uncovered PUBLIC repo (a tokenless sandbox clones it anonymously)", async () => {
    stubFetch({ mint: mintNoInstallation, ghApi: () => jsonRes(200, { private: false }) });
    expect(await resolveCloudRepoAccess("r1")).toEqual({ status: "ok", slug: SLUG });
  });

  it("needs_grant for a PRIVATE repo the App definitively does not cover", async () => {
    stubFetch({ mint: mintNoInstallation, ghApi: () => jsonRes(404, {}) });
    expect(await resolveCloudRepoAccess("r1")).toEqual({ status: "needs_grant", slug: SLUG });
  });

  it("unknown (never needs_grant) when the public probe is rate-limited", async () => {
    // The anonymous api.github.com probe hitting its 60/hr-per-IP limit (403)
    // must NOT be read as "private" — collapsing that into needs_grant would
    // falsely block (and hard-fail create for) a PUBLIC repo we couldn't verify.
    stubFetch({ mint: mintNoInstallation, ghApi: () => new Response(null, { status: 403 }) });
    expect(await resolveCloudRepoAccess("r1")).toEqual({ status: "unknown", slug: SLUG });
  });

  it("unknown (not needs_grant) when the App grant path is unconfigured (env-key / PAT-only)", async () => {
    // No deus-cloud session bits: the mint is definitive for "no context", NOT
    // "no App installation". A private repo here clones via the org PAT
    // server-side, so we must not prompt to install an App that isn't in use
    // (nor let the create-time gate hard-fail a create the PAT would satisfy).
    mockGetCloudConfig.mockReturnValue({ baseUrl: "https://api.agnt.test", apiKey: "agnt_sk" });
    stubFetch({ ghApi: () => jsonRes(404, {}) });
    expect(await resolveCloudRepoAccess("r1")).toEqual({ status: "unknown", slug: SLUG });
  });

  it("unknown (never needs_grant) on a transient mint failure — a blip must not prompt", async () => {
    // 5xx from deus-cloud is UNKNOWN, not definitive: it must not be mistaken
    // for "no access" and interrupt the user, even for a private repo.
    stubFetch({ mint: () => new Response(null, { status: 502 }), ghApi: () => jsonRes(404, {}) });
    expect(await resolveCloudRepoAccess("r1")).toEqual({ status: "unknown", slug: SLUG });
  });
});
