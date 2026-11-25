/**
 * Unit tests for the cloud-only automations service: the platform (mocked
 * @deus-hq/sdk) is the source of truth, deus mirrors it into a REAL in-memory
 * SQLite cache — the upsert/replace/adoption behaviour is SQL, so mocking the
 * database would only pin the strings, not the behaviour.
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// better-sqlite3 may be compiled for Electron's Node ABI — skip if unavailable
let canUseDatabase = true;
try {
  new Database(":memory:").close();
} catch {
  canUseDatabase = false;
}
const describeWithDb = canUseDatabase ? describe : describe.skip;

import { SCHEMA_SQL } from "@shared/schema";

const {
  mockGetDatabase,
  mockInvalidate,
  mockResetSubscribers,
  mockGetCloudConfig,
  mockGetCloudEnvironmentInfo,
  mockGetProviderAccounts,
  sdk,
} = vi.hoisted(() => ({
  mockGetDatabase: vi.fn(),
  mockInvalidate: vi.fn(),
  mockResetSubscribers: vi.fn(),
  mockGetCloudConfig: vi.fn(),
  mockGetCloudEnvironmentInfo: vi.fn(),
  mockGetProviderAccounts: vi.fn(),
  sdk: {
    createAutomation: vi.fn(),
    getAutomation: vi.fn(),
    listAutomations: vi.fn(),
    updateAutomation: vi.fn(),
    deleteAutomation: vi.fn(),
    pauseAutomation: vi.fn(),
    pauseWorkspace: vi.fn(),
    resumeAutomation: vi.fn(),
    triggerAutomation: vi.fn(),
    listAutomationRuns: vi.fn(),
    getSession: vi.fn(),
    createEnvironment: vi.fn(),
    listModels: vi.fn(),
  },
}));

vi.mock("../../../src/lib/database", () => ({ getDatabase: mockGetDatabase }));
vi.mock("../../../src/services/query-engine", () => ({ invalidate: mockInvalidate }));
const sendFrame = vi.hoisted(() => vi.fn());
vi.mock("../../../src/services/ws.service", () => ({
  getConnection: (id: string) => ({ deviceId: id }),
  sendFrame,
}));
vi.mock("../../../src/services/agent", () => ({ answerToolRequest: vi.fn() }));
vi.mock("../../../src/services/streams", () => ({
  resetSubscribers: mockResetSubscribers,
  dropConnection: vi.fn(),
}));
vi.mock("../../../src/services/agent/cloud/config", async () =>
  (await import("../../cloud-config-mock")).cloudConfigMock(mockGetCloudConfig)
);
vi.mock("../../../src/services/cloud-environment.service", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getCloudEnvironmentInfo: mockGetCloudEnvironmentInfo,
}));
vi.mock("../../../src/services/workspace.service", () => ({
  generateUniqueName: vi.fn(() => `adopted-${Math.random().toString(16).slice(2, 8)}`),
}));
vi.mock("../../../src/services/agent/cloud/driver", () => ({
  ensureCloudSession: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../../src/services/provider-accounts.service", () => ({
  getProviderAccounts: mockGetProviderAccounts,
}));
vi.mock("@deus-hq/sdk", async (importOriginal) => {
  const { Environment } = await importOriginal<typeof import("@deus-hq/sdk")>();
  return { ...sdk, Environment };
});

import { environmentNameForRepo } from "../../../src/services/cloud-environment.service";
import {
  createAutomation,
  deleteAutomation,
  listAutomations,
  openAutomationRun,
  refreshAutomations,
  initAutomations,
  runAutomationNow,
  toggleAutomation,
  updateAutomation,
  validateSchedule,
} from "../../../src/services/automations/service";
import { summaryToRow, runSummaryToRow } from "../../../src/services/automations/platform";
import { archiveWorkspace } from "../../../src/services/workspace-archive.service";
import { removeRepo, repoRemoval } from "../../../src/services/workspace-lifecycle";
import * as store from "../../../src/services/automations/store";
import { resetCloudModelListsForTests } from "../../../src/services/agent/cloud/models";
import { handleAutomationToolRequest } from "../../../src/services/automations/agent-rpc";

// ============================================================================
// Fixtures
// ============================================================================

const ORIGIN = "https://github.com/acme/widgets";
const noLiveTurn = () => undefined;
const AUTH = { baseUrl: "https://api.test", apiKey: "agnt_sk_test" };
const CLOUD_CONFIG = { ...AUTH, orgId: "org-1", deusCloudSessionToken: "workos-bearer" };
const AUTOMATION_AUTH = {
  baseUrl: "https://api.test/dashboard/orgs/org-1",
  apiKey: "workos-bearer",
};
const CLAUDE_ACCOUNT = {
  id: "claude-a",
  provider: "claude",
  authMethod: "api_key",
  label: "Work",
  email: null,
  planType: null,
  status: "connected",
  isDefault: true,
};
const WEEKDAYS_9 = "0 9 * * 1-5";
/** Every automation names its runs' model and thinking level; deus fills in neither. */
const RUN = { model: "claude-opus-5", thinking_level: "high" } as const;

/** What the platform's GET /models answers: the models runs may name, with their levels. */
const MODEL_LISTS = [
  {
    harness: "claude-code",
    source: "catalog",
    fetchedAt: 1,
    models: [
      {
        id: "claude-opus-5",
        harness: "claude-code",
        label: "Opus 5",
        thinking: { levels: ["low", "medium", "high", "xhigh", "max"] },
      },
      {
        id: "claude-opus-4-6",
        harness: "claude-code",
        label: "Opus 4.6",
        thinking: { levels: ["low", "medium", "high", "max"] },
      },
      { id: "haiku", harness: "claude-code", label: "Haiku 4.5", thinking: { levels: [] } },
    ],
  },
  {
    harness: "codex-app-server",
    source: "catalog",
    fetchedAt: 1,
    models: [
      {
        id: "gpt-6.1-sol",
        harness: "codex-app-server",
        label: "GPT-6.1-Sol",
        thinking: { levels: ["low", "medium", "high", "xhigh", "max", "ultra"] },
      },
    ],
  },
];

async function* gen<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

function summaryFixture(over: Record<string, unknown> = {}) {
  return {
    id: "auto-1",
    organizationId: "org-1",
    userId: null,
    name: "morning-pr-review",
    description: "Morning PR review",
    status: "active",
    spec: {
      triggers: [{ type: "cron", cron: WEEKDAYS_9, timezone: "Europe/Prague" }],
      prompt: "Review open PRs.",
      environment: "repo-acme-widgets-abc12345",
      model: "claude-opus-5",
      thinkingLevel: "high",
      sessionPolicy: "fresh_session",
      overlapPolicy: "skip",
    },
    externalIdentifier: null,
    deduplicationKey: null,
    webhookEnabled: false,
    nextRunAt: "2026-08-28T07:00:00.000Z",
    lastRunAt: "2026-08-27T07:00:00.000Z",
    consecutiveFailures: 0,
    pausedReason: null,
    pausedAt: null,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-27T07:00:00.000Z",
    ...over,
  } as never;
}

function runFixture(over: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    automationId: "auto-1",
    status: "succeeded",
    triggerMetadata: { type: "cron" },
    scheduledAt: "2026-08-27T07:00:00.000Z",
    startedAt: "2026-08-27T07:00:05.000Z",
    completedAt: "2026-08-27T07:04:00.000Z",
    sessionId: "run-1",
    turnId: "run-1",
    stopReason: "end_turn",
    error: null,
    cost: 0.42,
    summary: "Reviewed 3 PRs.",
    skipReason: null,
    deliveredAt: null,
    deliveryAttempts: null,
    ...over,
  } as never;
}

let db: Database.Database;
let envName: string;

beforeEach(async () => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  mockGetDatabase.mockReturnValue(db);
  mockInvalidate.mockClear();
  mockGetCloudConfig.mockReturnValue(CLOUD_CONFIG);
  mockGetProviderAccounts.mockReset().mockResolvedValue({
    accounts: [CLAUDE_ACCOUNT],
    defaultAccountIds: { claude: CLAUDE_ACCOUNT.id },
    providers: [],
  });
  envName = await environmentNameForRepo(ORIGIN);
  mockGetCloudEnvironmentInfo.mockResolvedValue({ configured: true, name: envName });
  for (const fn of Object.values(sdk)) fn.mockReset();
  resetCloudModelListsForTests();
  sdk.listModels.mockResolvedValue(MODEL_LISTS);
  db.prepare(
    `INSERT INTO repositories (id, name, root_path, git_origin_url) VALUES ('r1', 'widgets', '/tmp/widgets', ?)`
  ).run(ORIGIN);
});

afterEach(() => {
  db.close();
});

/** A platform summary whose environment points at the local repo r1. */
function localSummary(over: Record<string, unknown> = {}) {
  return summaryFixture({
    spec: {
      ...(summaryFixture() as { spec: Record<string, unknown> }).spec,
      environment: envName,
    },
    ...over,
  });
}

// ============================================================================
// Wire → row mapping
// ============================================================================

describeWithDb("summaryToRow", () => {
  it("maps the platform summary: display name, cron trigger, repo link", () => {
    const row = summaryToRow(
      summaryFixture() as never,
      new Map([["repo-acme-widgets-abc12345", "r1"]]),
      undefined,
      "org-1"
    );
    expect(row.id).toBe("auto-1");
    expect(row.organization_id).toBe("org-1");
    expect(row.name).toBe("Morning PR review");
    expect(row.cron).toBe(WEEKDAYS_9);
    expect(row.timezone).toBe("Europe/Prague");
    expect(row.repository_id).toBe("r1");
    expect(row.model).toBe("claude-opus-5");
    expect(row.consecutive_failures).toBe(0);
  });

  it("falls back to the slug name and null repo off this machine", () => {
    const row = summaryToRow(
      summaryFixture({ description: null }) as never,
      new Map(),
      undefined,
      "org-1"
    );
    expect(row.name).toBe("morning-pr-review");
    expect(row.repository_id).toBeNull();
  });

  it("preserves the deus-local columns from the previous row", () => {
    const row = summaryToRow(
      summaryFixture() as never,
      new Map(),
      { created_by: "agent", workspace_id: "w-held" },
      "org-1"
    );
    expect(row.created_by).toBe("agent");
    expect(row.workspace_id).toBe("w-held");
  });
});

describeWithDb("runSummaryToRow", () => {
  it("maps errors and folds the skip reason into the summary slot", () => {
    const failed = runSummaryToRow(
      runFixture({
        status: "failed",
        error: { code: "x", message: "boom" },
        summary: null,
      }) as never
    );
    expect(failed.error_message).toBe("boom");

    const skipped = runSummaryToRow(
      runFixture({ status: "skipped", summary: null, skipReason: "previous run live" }) as never
    );
    expect(skipped.summary).toBe("previous run live");
  });
});

// ============================================================================
// Sync (platform → cache)
// ============================================================================

describeWithDb("refreshAutomations", () => {
  it("keeps the project link empty when a refresh finishes after project removal", async () => {
    const reply = Promise.withResolvers<ReturnType<typeof localSummary>>();
    sdk.getAutomation.mockReturnValue(reply.promise);
    sdk.listAutomationRuns.mockReturnValue(gen([]));
    const refreshing = refreshAutomations("auto-1");
    removeRepo("r1", repoRemoval("r1", noLiveTurn).confirmation, noLiveTurn);
    reply.resolve(localSummary());
    await refreshing;
    expect(store.getAutomationRaw("auto-1")).toMatchObject({ repository_id: null });
  });

  it.each(["full", "single"])("discards an in-flight %s refresh after sign-out", async (kind) => {
    mockGetCloudConfig.mockReturnValue({ ...CLOUD_CONFIG, deusCloudSessionToken: `owner-${kind}` });
    let release!: (summary: ReturnType<typeof localSummary>) => void;
    const pendingSummary = new Promise<ReturnType<typeof localSummary>>((resolve) => {
      release = resolve;
    });
    sdk.listAutomations.mockReturnValue(
      (async function* () {
        yield await pendingSummary;
      })()
    );
    sdk.getAutomation.mockReturnValue(pendingSummary);
    sdk.listAutomationRuns.mockReturnValue(gen([]));
    const pending = refreshAutomations(kind === "single" ? "auto-1" : undefined);
    mockGetCloudConfig.mockReturnValue(null);
    initAutomations();
    release(localSummary());
    await pending;
    expect(listAutomations()).toEqual([]);
    expect(store.listRuns("auto-1")).toEqual([]);
  });

  it("refreshes the next account immediately and ignores the previous account's late result", async () => {
    mockGetCloudConfig.mockReturnValue({ ...CLOUD_CONFIG, deusCloudSessionToken: "owner-a" });
    let release!: (summary: ReturnType<typeof localSummary>) => void;
    const oldSummary = new Promise<ReturnType<typeof localSummary>>((resolve) => {
      release = resolve;
    });
    sdk.listAutomations.mockReturnValueOnce(
      (async function* () {
        yield await oldSummary;
      })()
    );
    const previous = refreshAutomations();
    mockGetCloudConfig.mockReturnValue({ ...CLOUD_CONFIG, deusCloudSessionToken: "owner-b" });
    sdk.listAutomations.mockReturnValueOnce(
      gen([localSummary({ id: "auto-b", description: "B's schedule" })])
    );
    await refreshAutomations();
    expect(listAutomations().map((automation) => automation.id)).toEqual(["auto-b"]);
    release(localSummary({ id: "auto-a", description: "A's private schedule" }));
    await previous;
    expect(listAutomations().map((automation) => automation.id)).toEqual(["auto-b"]);
  });

  it("mirrors the full list and drops rows the platform no longer has", async () => {
    store.upsertAutomation(
      summaryToRow(localSummary({ id: "gone" }) as never, new Map(), undefined, "org-1")
    );
    sdk.listAutomations.mockReturnValue(gen([localSummary()]));

    await refreshAutomations();

    const list = listAutomations();
    expect(list.map((a) => a.id)).toEqual(["auto-1"]);
    expect(list[0].repo_name).toBe("widgets");
    expect(mockInvalidate).toHaveBeenCalledWith(["automations"]);
  });

  it("a refresh of one organization replaces that organization's rows and leaves the other's", async () => {
    mockGetCloudConfig.mockReturnValue({
      ...CLOUD_CONFIG,
      orgKeys: { "org-1": "key-a", "org-b": "key-b" },
    });
    store.upsertAutomation(
      summaryToRow(localSummary({ id: "a-kept" }) as never, new Map(), undefined, "org-1")
    );
    store.upsertAutomation(
      summaryToRow(localSummary({ id: "b-gone" }) as never, new Map(), undefined, "org-b")
    );
    sdk.listAutomations.mockReturnValue(gen([localSummary({ id: "b-new" })]));

    await refreshAutomations(undefined, "org-b");

    // B's list, asked with the session in B's path, replaced only B's rows.
    expect(sdk.listAutomations).toHaveBeenCalledWith({
      baseUrl: "https://api.test/dashboard/orgs/org-b",
      apiKey: "workos-bearer",
    });
    const rows = db
      .prepare("SELECT id, organization_id FROM automations ORDER BY id")
      .all() as Array<{ id: string; organization_id: string | null }>;
    expect(rows).toEqual([
      { id: "a-kept", organization_id: "org-1" },
      { id: "b-new", organization_id: "org-b" },
    ]);
  });

  it("creates in the organization it is given, and later calls follow the row", async () => {
    mockGetCloudConfig.mockReturnValue({
      ...CLOUD_CONFIG,
      orgKeys: { "org-1": "key-a", "org-b": "key-b" },
    });
    sdk.createAutomation.mockResolvedValue({ id: "auto-b" });
    sdk.getAutomation.mockResolvedValue(localSummary({ id: "auto-b" }));
    await createAutomation(
      {
        repository_id: "r1",
        name: "B's schedule",
        prompt: "Review",
        cron: WEEKDAYS_9,
        organization_id: "org-b",
        ...RUN,
      },
      "user"
    );
    expect(sdk.createAutomation).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "https://api.test/dashboard/orgs/org-b" })
    );
    expect(mockGetCloudEnvironmentInfo).toHaveBeenCalledWith(expect.any(String), "org-b");
    expect(store.getAutomationRaw("auto-b")?.organization_id).toBe("org-b");

    sdk.pauseAutomation.mockResolvedValue(undefined);
    sdk.listAutomationRuns.mockReturnValue(gen([]));
    await toggleAutomation("auto-b", "paused");
    expect(sdk.pauseAutomation).toHaveBeenCalledWith("auto-b", {
      baseUrl: "https://api.test/dashboard/orgs/org-b",
      apiKey: "workos-bearer",
    });
  });

  it("single-automation refresh pulls the run ledger too", async () => {
    sdk.getAutomation.mockResolvedValue(localSummary());
    sdk.listAutomationRuns.mockReturnValue(gen([runFixture()]));

    await refreshAutomations("auto-1");

    expect(sdk.getAutomation).toHaveBeenCalledWith("auto-1", AUTOMATION_AUTH);
    expect(sdk.listAutomationRuns).toHaveBeenCalledWith("auto-1", AUTOMATION_AUTH);
    expect(store.listRuns("auto-1")).toHaveLength(1);
    expect(store.listRuns("auto-1")[0].provider_session_id).toBe("run-1");
  });

  it("is a no-op without cloud credentials", async () => {
    mockGetCloudConfig.mockReturnValue(null);
    await refreshAutomations();
    expect(sdk.listAutomations).not.toHaveBeenCalled();
  });

  it("mirrors every organization it holds a key for at start-up; one failing stops none", async () => {
    // A fresh account: the full refresh is throttled per account and organization.
    mockGetCloudConfig.mockReturnValue({
      ...CLOUD_CONFIG,
      deusCloudSessionToken: "owner-every-org",
      orgKeys: { "org-1": "key-a", "org-b": "key-b" },
    });
    await refreshAutomations("missing").catch(() => {});
    store.upsertAutomation(
      summaryToRow(localSummary({ id: "a-kept" }) as never, new Map(), undefined, "org-1")
    );
    store.upsertAutomation(
      summaryToRow(localSummary({ id: "b-gone" }) as never, new Map(), undefined, "org-b")
    );
    sdk.listAutomations.mockImplementation(({ baseUrl }: { baseUrl: string }) => {
      if (baseUrl.endsWith("/org-1")) throw new Error("platform unreachable");
      return gen([localSummary({ id: "b-new" })]);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    initAutomations();
    await vi.waitFor(() => expect(store.getAutomationRaw("b-new")).toBeTruthy());

    expect(sdk.listAutomations.mock.calls.map(([auth]) => auth.baseUrl).sort()).toEqual([
      "https://api.test/dashboard/orgs/org-1",
      "https://api.test/dashboard/orgs/org-b",
    ]);
    // The failed organization keeps its rows; the other's list replaced only its own.
    const rows = db
      .prepare("SELECT id, organization_id FROM automations ORDER BY id")
      .all() as Array<{ id: string; organization_id: string | null }>;
    expect(rows).toEqual([
      { id: "a-kept", organization_id: "org-1" },
      { id: "b-new", organization_id: "org-b" },
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("org-1"),
      expect.objectContaining({ message: "platform unreachable" })
    );
    warn.mockRestore();
  });

  it("the agent tool's list reads every organization it holds a key for before answering", async () => {
    mockGetCloudConfig.mockReturnValue({
      ...CLOUD_CONFIG,
      deusCloudSessionToken: "owner-agent-list",
      orgKeys: { "org-1": "key-a", "org-b": "key-b" },
    });
    sdk.listAutomations.mockImplementation(({ baseUrl }: { baseUrl: string }) =>
      gen([localSummary({ id: baseUrl.endsWith("/org-b") ? "b-1" : "a-1" })])
    );

    const answer = (await handleAutomationToolRequest({ sessionId: "s1", mode: "list" })) as {
      automations: Array<{ id: string; organization_id: string | null }>;
    };

    expect(answer.automations.map((a) => [a.id, a.organization_id]).sort()).toEqual([
      ["a-1", "org-1"],
      ["b-1", "org-b"],
    ]);
  });

  it("mirrors the default organization at start-up with only a developer key", async () => {
    mockGetCloudConfig.mockReturnValue({ ...CLOUD_CONFIG, deusCloudSessionToken: "owner-dev" });
    sdk.listAutomations.mockReturnValue(gen([localSummary()]));
    initAutomations();
    await vi.waitFor(() => expect(store.getAutomationRaw("auto-1")).toBeTruthy());
    expect(sdk.listAutomations).toHaveBeenCalledOnce();
    expect(sdk.listAutomations).toHaveBeenCalledWith({
      baseUrl: "https://api.test/dashboard/orgs/org-1",
      apiKey: "owner-dev",
    });
  });
});

// ============================================================================
// CRUD (platform calls + cache convergence)
// ============================================================================

describeWithDb("createAutomation", () => {
  beforeEach(() => {
    sdk.createAutomation.mockResolvedValue({ id: "auto-1", name: "morning-pr-review" });
    sdk.getAutomation.mockResolvedValue(localSummary());
    sdk.listAutomationRuns.mockReturnValue(gen([]));
  });

  it("creates on the platform and mirrors back with created_by", async () => {
    const created = await createAutomation(
      {
        ...RUN,
        repository_id: "r1",
        name: "Morning PR review",
        prompt: "Review open PRs.",
        cron: WEEKDAYS_9,
        timezone: "Europe/Prague",
      },
      "agent"
    );
    expect(sdk.createAutomation).toHaveBeenCalledWith(
      expect.objectContaining({
        ...AUTOMATION_AUTH,
        name: "morning-pr-review",
        description: "Morning PR review",
        cron: WEEKDAYS_9,
        environment: envName,
        // The caller's choice, passed through: nothing is filled in.
        model: "claude-opus-5",
        thinkingLevel: "high",
      })
    );
    // The environment already existed — no lazy create.
    expect(sdk.createEnvironment).not.toHaveBeenCalled();
    expect(created.created_by).toBe("agent");
    expect(created.repo_name).toBe("widgets");
  });

  it("keeps repository file discovery enabled when an automation creates its environment", async () => {
    mockGetCloudEnvironmentInfo.mockResolvedValue({ configured: false, name: envName });
    sdk.createEnvironment.mockResolvedValue({ id: "env-1", name: envName });
    await createAutomation(
      { ...RUN, repository_id: "r1", name: "X", prompt: "y", cron: WEEKDAYS_9 },
      "user"
    );
    expect(sdk.createEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({ ...AUTH, name: envName })
    );
    const { environment } = sdk.createEnvironment.mock.calls[0][0];
    expect(environment.toEnvironmentPayload(envName).config).toMatchObject({
      template: "agnt-base",
      repo: ORIGIN,
      project: { version: 1 },
    });
  });

  it.each(["codex only", "missing default", "reconnect required"])(
    "refuses to schedule Claude with %s",
    async (scenario) => {
      mockGetProviderAccounts.mockResolvedValueOnce({
        providers: [],
        accounts:
          scenario === "codex only"
            ? [{ ...CLAUDE_ACCOUNT, provider: "codex" }]
            : [
                {
                  ...CLAUDE_ACCOUNT,
                  ...(scenario === "reconnect required" ? { status: "reconnect_required" } : {}),
                },
              ],
        defaultAccountIds:
          scenario === "codex only"
            ? { codex: CLAUDE_ACCOUNT.id }
            : { claude: scenario === "missing default" ? "deleted-id" : CLAUDE_ACCOUNT.id },
      });
      await expect(
        createAutomation(
          { ...RUN, repository_id: "r1", name: "Audit", prompt: "Audit deps.", cron: WEEKDAYS_9 },
          "user"
        )
      ).rejects.toThrow(/Choose a connected Claude account/);
      expect(sdk.createAutomation).not.toHaveBeenCalled();
      expect(sdk.createEnvironment).not.toHaveBeenCalled();
    }
  );

  it("rejects an org device key without a signed-in product session", async () => {
    mockGetCloudConfig.mockReturnValue(AUTH);
    await expect(
      createAutomation(
        { ...RUN, repository_id: "r1", name: "Audit", prompt: "Audit deps.", cron: WEEKDAYS_9 },
        "user"
      )
    ).rejects.toThrow(/Sign in to Deus Cloud/);
    expect(mockGetProviderAccounts).not.toHaveBeenCalled();
    expect(sdk.createAutomation).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "refuses all writes after an account switch during environment lookup (configured=%s)",
    async (configured) => {
      mockGetCloudEnvironmentInfo.mockImplementationOnce(async () => {
        mockGetCloudConfig.mockReturnValue({
          ...CLOUD_CONFIG,
          apiKey: "other-device-key",
          orgId: "org-2",
          deusCloudSessionToken: "other-user",
        });
        return { configured, name: envName };
      });
      await expect(
        createAutomation(
          { ...RUN, repository_id: "r1", name: "Audit", prompt: "Audit deps.", cron: WEEKDAYS_9 },
          "user"
        )
      ).rejects.toThrow(/account changed/);
      expect(sdk.createEnvironment).not.toHaveBeenCalled();
      expect(sdk.createAutomation).not.toHaveBeenCalled();
    }
  );

  it.each(["create", "reconcile", "failed reconcile"])(
    "does not seed the previous account's prompt after a late %s response",
    async (stage) => {
      const signOut = () => {
        mockGetCloudConfig.mockReturnValue(null);
        initAutomations();
      };
      if (stage === "create") {
        sdk.createAutomation.mockImplementationOnce(async () => {
          signOut();
          return { id: "auto-1" };
        });
      } else {
        sdk.getAutomation.mockImplementationOnce(async () => {
          signOut();
          if (stage === "failed reconcile") throw new Error("Disconnected");
          return localSummary();
        });
      }
      await expect(
        createAutomation(
          {
            ...RUN,
            repository_id: "r1",
            name: "Private audit",
            prompt: "Private prompt",
            cron: WEEKDAYS_9,
          },
          "user"
        )
      ).rejects.toThrow(/account changed/);
      expect(sdk.createAutomation).toHaveBeenCalledTimes(1);
      expect(listAutomations()).toEqual([]);
    }
  );

  it("keeps an accepted create when its follow-up read fails under the same account", async () => {
    sdk.getAutomation.mockRejectedValueOnce(new Error("Temporarily unavailable"));
    const created = await createAutomation(
      { ...RUN, repository_id: "r1", name: "Audit", prompt: "Audit deps.", cron: WEEKDAYS_9 },
      "user"
    );
    expect(created).toMatchObject({ name: "Audit", prompt: "Audit deps.", status: "active" });
    expect(sdk.createAutomation).toHaveBeenCalledTimes(1);
  });

  it("rejects without cloud credentials, a remote, or a sane schedule", async () => {
    mockGetCloudConfig.mockReturnValue(null);
    await expect(
      createAutomation(
        { ...RUN, repository_id: "r1", name: "X", prompt: "y", cron: WEEKDAYS_9 },
        "user"
      )
    ).rejects.toThrow(/Deus Cloud/);

    mockGetCloudConfig.mockReturnValue(CLOUD_CONFIG);
    db.prepare("UPDATE repositories SET git_origin_url = NULL WHERE id = 'r1'").run();
    await expect(
      createAutomation(
        { ...RUN, repository_id: "r1", name: "X", prompt: "y", cron: WEEKDAYS_9 },
        "user"
      )
    ).rejects.toThrow(/git remote/);

    db.prepare("UPDATE repositories SET git_origin_url = ? WHERE id = 'r1'").run(ORIGIN);
    await expect(
      createAutomation(
        { ...RUN, repository_id: "r1", name: "X", prompt: "y", cron: "* * * * *" },
        "user"
      )
    ).rejects.toThrow(/5 minutes/);
  });
});

describeWithDb("automation model choice", () => {
  beforeEach(() => {
    store.upsertAutomation(
      summaryToRow(localSummary() as never, new Map([[envName, "r1"]]), undefined, "org-1")
    );
    sdk.getAutomation.mockResolvedValue(localSummary());
    sdk.listAutomationRuns.mockReturnValue(gen([]));
  });

  it("refuses to create one that leaves out its model or thinking level", async () => {
    const task = { repository_id: "r1", name: "X", prompt: "y", cron: WEEKDAYS_9 };
    await expect(createAutomation({ ...task, thinking_level: "high" }, "user")).rejects.toThrow(
      /Choose the Claude model/
    );
    await expect(createAutomation({ ...task, model: "claude-opus-5" }, "agent")).rejects.toThrow(
      /Choose the thinking level/
    );
    expect(sdk.createAutomation).not.toHaveBeenCalled();
  });

  it("saves one stored before AGNT required a thinking level only once it is chosen", async () => {
    // Saved before the rule: the platform's spec names its model but no thinking level.
    const { thinkingLevel: _unset, ...savedBeforeTheRule } = (
      localSummary() as { spec: Record<string, unknown> }
    ).spec;
    sdk.getAutomation.mockResolvedValue(localSummary({ spec: savedBeforeTheRule }));
    await expect(updateAutomation("auto-1", { name: "Renamed" })).rejects.toThrow(
      /Choose the model and thinking level/
    );
    expect(sdk.updateAutomation).not.toHaveBeenCalled();

    await updateAutomation("auto-1", { name: "Renamed", thinking_level: "medium" });
    expect(sdk.updateAutomation.mock.lastCall?.[1]?.spec).toMatchObject({
      model: "claude-opus-5",
      thinkingLevel: "medium",
    });
  });

  it("refuses a model Deus Cloud does not list, naming the ones it does", async () => {
    await expect(
      createAutomation(
        {
          repository_id: "r1",
          name: "X",
          prompt: "y",
          cron: WEEKDAYS_9,
          model: "claude-fable-5[1m]",
          thinking_level: "high",
        },
        "agent"
      )
    ).rejects.toThrow(/doesn't run "claude-fable-5\[1m\]".*claude-opus-5, claude-opus-4-6, haiku/);
    expect(sdk.createAutomation).not.toHaveBeenCalled();
  });

  it("refuses a level the model does not list instead of letting the platform run another", async () => {
    // AGNT would run Opus 4.6's nearest level, `high`, in place of the `xhigh` asked for.
    await expect(
      createAutomation(
        {
          repository_id: "r1",
          name: "X",
          prompt: "y",
          cron: WEEKDAYS_9,
          model: "claude-opus-4-6",
          thinking_level: "xhigh",
        },
        "user"
      )
    ).rejects.toThrow(/Opus 4\.6 runs thinking low, medium, high, max/);
    expect(sdk.createAutomation).not.toHaveBeenCalled();
  });

  it("names the platform's levels the local engine lacks, and off for a model with none", async () => {
    sdk.createAutomation.mockResolvedValue({ id: "auto-1" });
    sdk.getAutomation.mockResolvedValue(localSummary());
    await createAutomation(
      {
        ...RUN,
        thinking_level: "max",
        repository_id: "r1",
        name: "X",
        prompt: "y",
        cron: WEEKDAYS_9,
      },
      "user"
    );
    expect(sdk.createAutomation).toHaveBeenLastCalledWith(
      expect.objectContaining({ model: "claude-opus-5", thinkingLevel: "max" })
    );

    await createAutomation(
      {
        model: "haiku",
        thinking_level: "off",
        repository_id: "r1",
        name: "Y",
        prompt: "y",
        cron: WEEKDAYS_9,
      },
      "user"
    );
    expect(sdk.createAutomation).toHaveBeenLastCalledWith(
      expect.objectContaining({ model: "haiku", thinkingLevel: "off" })
    );
  });

  it("keeps a saved model the list no longer names, and checks a new level against a listed one", async () => {
    sdk.getAutomation.mockResolvedValue(
      localSummary({
        spec: {
          ...(localSummary() as { spec: Record<string, unknown> }).spec,
          model: "claude-opus-4-1",
          thinkingLevel: "xhigh",
        },
      })
    );
    // Carried over, not chosen now: the platform still judges it.
    await updateAutomation("auto-1", { thinking_level: "low" });
    expect(sdk.updateAutomation.mock.lastCall?.[1]?.spec).toMatchObject({
      model: "claude-opus-4-1",
      thinkingLevel: "low",
    });

    sdk.updateAutomation.mockClear();
    // A model chosen now keeps the saved level, which Opus 4.6 does not list.
    await expect(updateAutomation("auto-1", { model: "claude-opus-4-6" })).rejects.toThrow(
      /Opus 4\.6 runs thinking/
    );
    await expect(updateAutomation("auto-1", { model: "claude-opus-4-1" })).rejects.toThrow(
      /doesn't run "claude-opus-4-1"/
    );
    expect(sdk.updateAutomation).not.toHaveBeenCalled();
  });

  it("leaves the choice to the platform when its list cannot be read", async () => {
    sdk.listModels.mockRejectedValue(new Error("platform unavailable"));
    sdk.createAutomation.mockResolvedValue({ id: "auto-1" });
    sdk.getAutomation.mockResolvedValue(localSummary());
    await createAutomation(
      {
        ...RUN,
        model: "claude-opus-4-1",
        repository_id: "r1",
        name: "X",
        prompt: "y",
        cron: WEEKDAYS_9,
      },
      "agent"
    );
    expect(sdk.createAutomation).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-opus-4-1", thinkingLevel: "high" })
    );
  });

  it("lists the models runs can use for the agent's tool, with each one's levels", async () => {
    await expect(handleAutomationToolRequest({ sessionId: "s1", mode: "models" })).resolves.toEqual(
      {
        models: [
          {
            id: "claude-opus-5",
            label: "Opus 5",
            thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
          },
          {
            id: "claude-opus-4-6",
            label: "Opus 4.6",
            thinkingLevels: ["low", "medium", "high", "max"],
          },
          { id: "haiku", label: "Haiku 4.5", thinkingLevels: ["off"] },
        ],
      }
    );
  });
});

describeWithDb("automation mutation identity", () => {
  it("does not create an environment for a retarget after an account switch during environment lookup", async () => {
    store.upsertAutomation(
      summaryToRow(localSummary() as never, new Map([[envName, "r1"]]), undefined, "org-1")
    );
    db.prepare(
      "INSERT INTO repositories (id, name, root_path, git_origin_url) VALUES ('r2', 'private', '/tmp/private', ?)"
    ).run("https://github.com/acme/private");
    sdk.getAutomation.mockResolvedValue(localSummary());
    mockGetCloudEnvironmentInfo.mockImplementationOnce(async () => {
      mockGetCloudConfig.mockReturnValue({
        ...CLOUD_CONFIG,
        apiKey: "other-device-key",
        orgId: "org-2",
        deusCloudSessionToken: "other-user",
      });
      return { configured: false, name: "private-env" };
    });
    await expect(updateAutomation("auto-1", { repository_id: "r2" })).rejects.toThrow(
      /account changed/
    );
    expect(sdk.createEnvironment).not.toHaveBeenCalled();
    expect(sdk.updateAutomation).not.toHaveBeenCalled();
    expect(store.getAutomationRaw("auto-1")?.repository_id).toBe("r1");
  });

  it.each(["update", "pause", "delete", "run now"])(
    "drops a late %s result after sign-out",
    async (operation) => {
      store.upsertAutomation(summaryToRow(localSummary() as never, new Map(), undefined, "org-1"));
      sdk.getAutomation.mockResolvedValue(localSummary());
      const signOut = async () => {
        mockGetCloudConfig.mockReturnValue(null);
        initAutomations();
        return { runId: "run-9", status: "queued" };
      };
      sdk.updateAutomation.mockImplementationOnce(signOut);
      sdk.pauseAutomation.mockImplementationOnce(signOut);
      sdk.deleteAutomation.mockImplementationOnce(signOut);
      sdk.triggerAutomation.mockImplementationOnce(signOut);
      const pending =
        operation === "update"
          ? updateAutomation("auto-1", { name: "Updated" })
          : operation === "pause"
            ? toggleAutomation("auto-1", "paused")
            : operation === "delete"
              ? deleteAutomation("auto-1")
              : runAutomationNow("auto-1");
      await expect(pending).rejects.toThrow(/account changed/);
      expect(listAutomations()).toEqual([]);
      expect(store.listRuns("auto-1")).toEqual([]);
    }
  );
});

describeWithDb("toggleAutomation", () => {
  it("routes pause/resume to the platform and re-mirrors", async () => {
    store.upsertAutomation(summaryToRow(localSummary() as never, new Map(), undefined, "org-1"));
    sdk.pauseAutomation.mockResolvedValue(undefined);
    sdk.getAutomation.mockResolvedValue(
      localSummary({ status: "paused", pausedReason: "manual", nextRunAt: null })
    );
    sdk.listAutomationRuns.mockReturnValue(gen([]));

    const paused = await toggleAutomation("auto-1", "paused");
    expect(sdk.pauseAutomation).toHaveBeenCalledWith(
      "auto-1",
      expect.objectContaining(AUTOMATION_AUTH)
    );
    expect(paused.status).toBe("paused");
    expect(paused.paused_reason).toBe("manual");
    expect(paused.next_run_at).toBeNull();
  });
});

describeWithDb("deleteAutomation", () => {
  it("deletes on the platform and cascades the cache", async () => {
    store.upsertAutomation(summaryToRow(localSummary() as never, new Map(), undefined, "org-1"));
    store.upsertRuns([runSummaryToRow(runFixture() as never)]);
    sdk.deleteAutomation.mockResolvedValue(undefined);

    await deleteAutomation("auto-1");
    expect(sdk.deleteAutomation).toHaveBeenCalledWith("auto-1", AUTOMATION_AUTH);
    expect(listAutomations()).toHaveLength(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM automation_runs").get()).toEqual({ n: 0 });
  });
});

describeWithDb("a write in one organization", () => {
  it("does not make another organization's full refresh drop its list", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      mockGetCloudConfig.mockReturnValue({
        ...CLOUD_CONFIG,
        deusCloudSessionToken: "owner-two-orgs",
        orgKeys: { "org-1": "key-a", "org-b": "key-b" },
      });
      await refreshAutomations("missing").catch(() => {});
      store.upsertAutomation(
        summaryToRow(localSummary({ id: "b-1" }) as never, new Map(), undefined, "org-b")
      );
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      sdk.listAutomations.mockReturnValue(
        (async function* () {
          await held;
          yield localSummary({ id: "a-new" });
        })()
      );
      const refreshing = refreshAutomations(undefined, "org-1");

      // Org B's automation is deleted while org 1's list is being read.
      vi.setSystemTime(Date.now() + 1_000);
      sdk.deleteAutomation.mockResolvedValue(undefined);
      await deleteAutomation("b-1");
      release();
      await refreshing;

      expect(store.getAutomationRaw("a-new")?.organization_id).toBe("org-1");
    } finally {
      vi.useRealTimers();
    }
  });
});

describeWithDb("runAutomationNow", () => {
  it("triggers a platform fire and seeds the ledger row", async () => {
    store.upsertAutomation(summaryToRow(localSummary() as never, new Map(), undefined, "org-1"));
    sdk.triggerAutomation.mockResolvedValue({
      runId: "run-9",
      automationId: "auto-1",
      status: "queued",
    });

    const runId = await runAutomationNow("auto-1");
    expect(runId).toBe("run-9");
    expect(sdk.triggerAutomation).toHaveBeenCalledWith(
      "auto-1",
      expect.objectContaining(AUTOMATION_AUTH)
    );
    const runs = store.listRuns("auto-1");
    expect(runs[0]).toMatchObject({ id: "run-9", status: "queued", trigger: "manual" });
  });
});

// ============================================================================
// Run adoption
// ============================================================================

describeWithDb("openAutomationRun", () => {
  beforeEach(() => {
    store.upsertAutomation(
      summaryToRow(localSummary() as never, new Map([[envName, "r1"]]), undefined, "org-1")
    );
    store.upsertRuns([runSummaryToRow(runFixture() as never)]);
    sdk.getSession.mockResolvedValue({
      workspaceId: "agnt-ws-1",
      session: {},
      status: "idle",
      messages: [],
      createdAt: null,
    });
  });

  it("adopts one workspace and one chat when two first opens both read the platform", async () => {
    const detail = Promise.withResolvers<{ workspaceId: string; messages: [] }>();
    sdk.getSession.mockReturnValue(detail.promise);
    const opens = [openAutomationRun("run-1"), openAutomationRun("run-1")];
    expect(sdk.getSession).toHaveBeenCalledTimes(2);
    detail.resolve({ workspaceId: "agnt-ws-1", messages: [] });
    const [first, second] = await Promise.all(opens);
    expect(sdk.getSession).toHaveBeenCalledWith("run-1", AUTH);
    const workspace = db
      .prepare("SELECT * FROM workspaces WHERE id = ?")
      .get(first.workspaceId) as Record<string, unknown>;
    expect(workspace.kind).toBe("cloud");
    expect(workspace.provider_workspace_id).toBe("agnt-ws-1");
    expect(workspace.title).toBe("Morning PR review");
    const session = db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(first.sessionId) as Record<string, unknown>;
    expect(session.provider_session_id).toBe("run-1");

    expect(second).toEqual(first);
    expect(db.prepare("SELECT COUNT(*) AS n FROM workspaces").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 1 });
  });

  it("refuses adoption when the session detail arrives after project removal", async () => {
    const detail = Promise.withResolvers<{ workspaceId: string; messages: [] }>();
    sdk.getSession.mockReturnValue(detail.promise);
    const opening = openAutomationRun("run-1");
    expect(sdk.getSession).toHaveBeenCalledOnce();
    removeRepo("r1", repoRemoval("r1", noLiveTurn).confirmation, noLiveTurn);
    detail.resolve({ workspaceId: "agnt-ws-1", messages: [] });
    await expect(opening).rejects.toThrow("This automation's repository isn't on this Mac.");
    expect(db.prepare("SELECT id FROM workspaces").all()).toEqual([]);
    expect(db.prepare("SELECT id FROM sessions").all()).toEqual([]);
    expect(store.getRun("run-1")).toMatchObject({ workspace_id: null, session_id: null });
  });

  it("keeps the project of an archived automation run's cloud workspace", async () => {
    const { confirmation } = repoRemoval("r1", noLiveTurn);
    const { workspaceId } = await openAutomationRun("run-1");
    await archiveWorkspace(workspaceId);
    expect(() => removeRepo("r1", confirmation, noLiveTurn)).toThrow(
      "This project has cloud workspaces, so it can't be removed yet."
    );
    expect(store.getRun("run-1")?.workspace_id).toBe(workspaceId);
  });

  it.each(["ready", "archived"])(
    "reuses the newest %s workspace on the computer for a new chat",
    async (state) => {
      const insert = db.prepare(
        `INSERT INTO workspaces (id, repository_id, slug, provider_workspace_id, state, updated_at)
       VALUES (?, 'r1', ?, 'agnt-ws-1', ?, ?)`
      );
      insert.run("oldest", "oldest", state, "2026-01-01");
      insert.run("newest", "newest", state, "2026-01-02");
      if (state === "ready") insert.run("archived", "archived", "archived", "2026-01-03");
      const { workspaceId } = await openAutomationRun("run-1");
      expect(workspaceId).toBe("newest");
      expect(db.prepare("SELECT state FROM workspaces WHERE id = ?").get(workspaceId)).toEqual({
        state: "ready",
      });
    }
  );

  it("tells whoever has the chat open to read it again once its transcript is filled in", async () => {
    sdk.getSession.mockResolvedValue({
      workspaceId: "agnt-ws-1",
      session: {},
      status: "idle",
      messages: [{ id: "ran-in-the-cloud", role: "assistant", parts: [] }],
      createdAt: null,
    });
    mockResetSubscribers.mockClear();

    const adopted = await openAutomationRun("run-1");

    expect(db.prepare("SELECT id FROM messages").all()).toEqual([{ id: "ran-in-the-cloud" }]);
    // No event of the chat announced these rows: its stream says to read the page again.
    expect(mockResetSubscribers).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: "sessionEvents" }),
      { sessionId: adopted.sessionId }
    );
  });

  it("revives an archived owner on adoption and on reopen, with each path's live reads", async () => {
    const first = await openAutomationRun("run-1");
    const archive = db.prepare(
      "UPDATE workspaces SET state = 'archived', current_session_id = NULL WHERE id = ?"
    );
    const workspace = db.prepare("SELECT state, current_session_id FROM workspaces WHERE id = ?");
    const ready = { state: "ready", current_session_id: first.sessionId };
    expect(workspace.get(first.workspaceId)).toEqual(ready);

    archive.run(first.workspaceId);
    mockInvalidate.mockClear();
    expect(await openAutomationRun("run-1")).toEqual(first);
    expect(workspace.get(first.workspaceId)).toEqual(ready);
    expect(mockInvalidate).toHaveBeenCalledExactlyOnceWith(["workspaces"]);

    // An unadopted ledger entry may point to the same platform session.
    db.prepare(
      "UPDATE automation_runs SET session_id = NULL, workspace_id = NULL WHERE id = 'run-1'"
    ).run();
    archive.run(first.workspaceId);
    db.exec(
      "INSERT INTO workspaces (id, repository_id, slug, provider_workspace_id) VALUES ('other', 'r1', 'other', 'agnt-ws-1')"
    );
    mockInvalidate.mockClear();
    expect(await openAutomationRun("run-1")).toEqual(first);
    expect(workspace.get(first.workspaceId)).toEqual(ready);
    expect(mockInvalidate).toHaveBeenCalledTimes(2);
    expect(mockInvalidate).toHaveBeenCalledWith(["workspaces"]);
    expect(mockInvalidate).toHaveBeenCalledWith(
      ["workspaces", "sessions", "session", "automations", "automationRuns"],
      { sessionIds: [first.sessionId] }
    );
  });

  it.each([false, true])(
    "backfills an adopted=%s run during archive and opens it after the pause",
    async (linked) => {
      const first = await openAutomationRun("run-1");
      if (!linked) db.exec("UPDATE automation_runs SET session_id = NULL, workspace_id = NULL");
      const gate = Promise.withResolvers<void>();
      sdk.pauseWorkspace.mockReturnValueOnce(gate.promise);
      const closing = archiveWorkspace(first.workspaceId);
      await vi.waitFor(() => expect(sdk.pauseWorkspace).toHaveBeenCalledOnce());
      sdk.getSession.mockResolvedValueOnce({
        workspaceId: "agnt-ws-1",
        messages: [{ id: "while-pausing", role: "assistant", parts: [] }],
      });
      let finished = false;
      const opening = openAutomationRun("run-1").then(() => {
        finished = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const premature = finished;
      const transcript = db
        .prepare("SELECT id FROM messages WHERE session_id = ?")
        .all(first.sessionId);
      gate.resolve();
      await Promise.all([closing, opening]);
      expect(transcript).toEqual([{ id: "while-pausing" }]);
      expect(premature).toBe(false);
      expect(db.prepare("SELECT state FROM workspaces").pluck().get()).toBe("ready");
    }
  );

  it("resurfaces the selected run when Archive completes during its transcript read", async () => {
    const first = await openAutomationRun("run-1");
    store.upsertRuns([runSummaryToRow(runFixture({ id: "run-2", sessionId: "run-2" }))]);
    const second = await openAutomationRun("run-2");
    const transcript = Promise.withResolvers<{ workspaceId: string; messages: [] }>();
    sdk.getSession.mockClear().mockReturnValueOnce(transcript.promise);
    const opening = openAutomationRun("run-1");
    const workspace = db.prepare("SELECT state, current_session_id FROM workspaces WHERE id = ?");
    try {
      expect(sdk.getSession).toHaveBeenCalledExactlyOnceWith("run-1", AUTH);
      await archiveWorkspace(first.workspaceId);
      expect(workspace.get(first.workspaceId)).toEqual({
        state: "archived",
        current_session_id: second.sessionId,
      });
    } finally {
      transcript.resolve({ workspaceId: "agnt-ws-1", messages: [] });
      await opening;
    }
    expect(workspace.get(first.workspaceId)).toEqual({
      state: "ready",
      current_session_id: first.sessionId,
    });
  });

  it("sends a new selection to both subscribed devices and stays quiet on a second open", async () => {
    const first = await openAutomationRun("run-1");
    store.upsertRuns([runSummaryToRow(runFixture({ id: "run-2", sessionId: "run-2" }))]);
    await openAutomationRun("run-2");
    const engine = await vi.importActual<typeof import("../../../src/services/query-engine")>(
      "../../../src/services/query-engine"
    );
    const { Registry } = await import("../../../src/api/registry");
    const { default: operations } = await import("../../../src/api/workspaces");
    engine.serveOperations(new Registry(operations));
    const frames = new Map(["window", "phone"].map((id) => [id, vi.fn()]));
    sendFrame.mockImplementation((id, frame) => frames.get(id)?.(frame));
    for (const [id, send] of frames) {
      engine.handleFrame(id, { type: "q:subscribe", resource: "workspaces", id: "sidebar" });
      expect(send).toHaveBeenCalledOnce();
      send.mockClear();
    }
    try {
      await mockInvalidate.withImplementation(engine.invalidate, async () => {
        await openAutomationRun("run-1");
        await openAutomationRun("run-1");
      });
      for (const send of frames.values()) {
        expect(send).toHaveBeenCalledOnce();
        expect(send.mock.calls[0][0].data[0].workspaces).toContainEqual(
          expect.objectContaining({ id: first.workspaceId, current_session_id: first.sessionId })
        );
      }
    } finally {
      for (const id of frames.keys()) engine.removeSubs(id);
    }
  });

  it("does not adopt a late session after the account changes", async () => {
    sdk.getSession.mockImplementationOnce(async () => {
      mockGetCloudConfig.mockReturnValue({
        ...CLOUD_CONFIG,
        apiKey: "agnt_sk_other",
        orgId: "org-2",
        deusCloudSessionToken: "other-account-bearer",
      });
      sdk.listAutomations.mockReturnValue(gen([]));
      await refreshAutomations();
      return {
        workspaceId: "agnt-ws-1",
        messages: [{ id: "old-account-message", role: "assistant", parts: [] }],
      };
    });

    await expect(openAutomationRun("run-1")).rejects.toThrow(/account changed/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM workspaces").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 0 });
  });

  it("does not backfill or revive an adopted run after the account changes", async () => {
    const adopted = store.adoptRunRows({
      runId: "run-1",
      automationId: "auto-1",
      repositoryId: "r1",
      automationName: "Morning PR review",
      providerSessionId: "run-1",
      providerWorkspaceId: "agnt-ws-1",
      organizationId: "org-1",
      newWorkspaceSlug: () => "adopted-run",
    });
    db.prepare("UPDATE workspaces SET state = 'archived' WHERE id = ?").run(adopted.workspaceId);
    mockInvalidate.mockClear();
    mockResetSubscribers.mockClear();
    sdk.getSession.mockImplementationOnce(async () => {
      mockGetCloudConfig.mockReturnValue({
        ...CLOUD_CONFIG,
        apiKey: "agnt_sk_other",
        orgId: "org-2",
        deusCloudSessionToken: "other-account-bearer",
      });
      sdk.listAutomations.mockReturnValue(gen([]));
      await refreshAutomations();
      return {
        workspaceId: "agnt-ws-1",
        messages: [{ id: "old-account-message", role: "assistant", parts: [] }],
      };
    });

    await expect(openAutomationRun("run-1")).rejects.toThrow(/account changed/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 0 });
    expect(
      db.prepare("SELECT state FROM workspaces WHERE id = ?").get(adopted.workspaceId)
    ).toEqual({
      state: "archived",
    });
    // Nothing of the other account's transcript was written, so nobody is told to read it.
    expect(mockResetSubscribers).not.toHaveBeenCalled();
  });

  it("refuses when the run has no session or the repo isn't local", async () => {
    store.upsertRuns([
      runSummaryToRow(runFixture({ id: "run-skip", status: "skipped", sessionId: null }) as never),
    ]);
    await expect(openAutomationRun("run-skip")).rejects.toThrow(/no session/);

    store.updateLocalColumns("auto-1", {});
    db.prepare("UPDATE automations SET repository_id = NULL WHERE id = 'auto-1'").run();
    await expect(openAutomationRun("run-1")).rejects.toThrow(/isn't on this Mac/);
  });
});

// ============================================================================
// Schedule preflight
// ============================================================================

describeWithDb("validateSchedule", () => {
  it("accepts a weekday-morning cron and rejects the floor + bad timezones", () => {
    expect(() => validateSchedule(WEEKDAYS_9, null)).not.toThrow();
    expect(() => validateSchedule("* * * * *", null)).toThrow(/5 minutes/);
    expect(() => validateSchedule(WEEKDAYS_9, "Mars/Olympus")).toThrow(/Invalid schedule/);
    expect(() => validateSchedule("not a cron", null)).toThrow(/Invalid schedule/);
  });
});
