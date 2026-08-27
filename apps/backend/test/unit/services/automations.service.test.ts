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

const { mockGetDatabase, mockInvalidate, mockGetCloudConfig, mockGetCloudEnvironmentInfo, sdk } =
  vi.hoisted(() => ({
    mockGetDatabase: vi.fn(),
    mockInvalidate: vi.fn(),
    mockGetCloudConfig: vi.fn(),
    mockGetCloudEnvironmentInfo: vi.fn(),
    sdk: {
      createAutomation: vi.fn(),
      getAutomation: vi.fn(),
      listAutomations: vi.fn(),
      updateAutomation: vi.fn(),
      deleteAutomation: vi.fn(),
      pauseAutomation: vi.fn(),
      resumeAutomation: vi.fn(),
      triggerAutomation: vi.fn(),
      listAutomationRuns: vi.fn(),
      getSession: vi.fn(),
      createEnvironment: vi.fn(),
    },
  }));

vi.mock("../../../src/lib/database", () => ({ getDatabase: mockGetDatabase }));
vi.mock("../../../src/services/query-engine", () => ({ invalidate: mockInvalidate }));
vi.mock("../../../src/services/agent/cloud/config", () => ({
  getCloudConfig: mockGetCloudConfig,
}));
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
vi.mock("@deus-hq/sdk", () => ({
  ...sdk,
  Environment: { from: vi.fn(() => ({ repo: vi.fn().mockReturnThis() })) },
}));

import { environmentNameForRepo } from "../../../src/services/cloud-environment.service";
import {
  createAutomation,
  deleteAutomation,
  listAutomations,
  openAutomationRun,
  refreshAutomations,
  runAutomationNow,
  toggleAutomation,
  validateSchedule,
} from "../../../src/services/automations/service";
import { summaryToRow, runSummaryToRow } from "../../../src/services/automations/platform";
import * as store from "../../../src/services/automations/store";

// ============================================================================
// Fixtures
// ============================================================================

const ORIGIN = "https://github.com/acme/widgets";
const AUTH = { baseUrl: "https://api.test", apiKey: "agnt_sk_test" };
const WEEKDAYS_9 = "0 9 * * 1-5";

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
  mockGetCloudConfig.mockReturnValue(AUTH);
  envName = await environmentNameForRepo(ORIGIN);
  mockGetCloudEnvironmentInfo.mockResolvedValue({ configured: true, name: envName });
  for (const fn of Object.values(sdk)) fn.mockReset();
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
      new Map([["repo-acme-widgets-abc12345", "r1"]])
    );
    expect(row.id).toBe("auto-1");
    expect(row.name).toBe("Morning PR review");
    expect(row.cron).toBe(WEEKDAYS_9);
    expect(row.timezone).toBe("Europe/Prague");
    expect(row.repository_id).toBe("r1");
    expect(row.model).toBe("claude-opus-5");
    expect(row.consecutive_failures).toBe(0);
  });

  it("falls back to the slug name and null repo off this machine", () => {
    const row = summaryToRow(summaryFixture({ description: null }) as never, new Map());
    expect(row.name).toBe("morning-pr-review");
    expect(row.repository_id).toBeNull();
  });

  it("preserves the deus-local columns from the previous row", () => {
    const row = summaryToRow(summaryFixture() as never, new Map(), {
      created_by: "agent",
      workspace_id: "w-held",
    });
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
  it("mirrors the full list and drops rows the platform no longer has", async () => {
    store.upsertAutomation(summaryToRow(localSummary({ id: "gone" }) as never, new Map()));
    sdk.listAutomations.mockReturnValue(gen([localSummary()]));

    await refreshAutomations();

    const list = listAutomations();
    expect(list.map((a) => a.id)).toEqual(["auto-1"]);
    expect(list[0].repo_name).toBe("widgets");
    expect(mockInvalidate).toHaveBeenCalledWith(["automations"]);
  });

  it("single-automation refresh pulls the run ledger too", async () => {
    sdk.getAutomation.mockResolvedValue(localSummary());
    sdk.listAutomationRuns.mockReturnValue(gen([runFixture()]));

    await refreshAutomations("auto-1");

    expect(store.listRuns("auto-1")).toHaveLength(1);
    expect(store.listRuns("auto-1")[0].provider_session_id).toBe("run-1");
  });

  it("is a no-op without cloud credentials", async () => {
    mockGetCloudConfig.mockReturnValue(null);
    await refreshAutomations();
    expect(sdk.listAutomations).not.toHaveBeenCalled();
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
        name: "morning-pr-review",
        description: "Morning PR review",
        cron: WEEKDAYS_9,
        environment: envName,
      })
    );
    // The environment already existed — no lazy create.
    expect(sdk.createEnvironment).not.toHaveBeenCalled();
    expect(created.created_by).toBe("agent");
    expect(created.repo_name).toBe("widgets");
  });

  it("lazily creates the repo's platform environment when missing", async () => {
    mockGetCloudEnvironmentInfo.mockResolvedValue({ configured: false, name: envName });
    sdk.createEnvironment.mockResolvedValue({ id: "env-1", name: envName });
    await createAutomation(
      { repository_id: "r1", name: "X", prompt: "y", cron: WEEKDAYS_9 },
      "user"
    );
    expect(sdk.createEnvironment).toHaveBeenCalledWith(expect.objectContaining({ name: envName }));
  });

  it("rejects without cloud credentials, a remote, or a sane schedule", async () => {
    mockGetCloudConfig.mockReturnValue(null);
    await expect(
      createAutomation({ repository_id: "r1", name: "X", prompt: "y", cron: WEEKDAYS_9 }, "user")
    ).rejects.toThrow(/Deus Cloud/);

    mockGetCloudConfig.mockReturnValue(AUTH);
    db.prepare("UPDATE repositories SET git_origin_url = NULL WHERE id = 'r1'").run();
    await expect(
      createAutomation({ repository_id: "r1", name: "X", prompt: "y", cron: WEEKDAYS_9 }, "user")
    ).rejects.toThrow(/git remote/);

    db.prepare("UPDATE repositories SET git_origin_url = ? WHERE id = 'r1'").run(ORIGIN);
    await expect(
      createAutomation({ repository_id: "r1", name: "X", prompt: "y", cron: "* * * * *" }, "user")
    ).rejects.toThrow(/5 minutes/);
  });
});

describeWithDb("toggleAutomation", () => {
  it("routes pause/resume to the platform and re-mirrors", async () => {
    store.upsertAutomation(summaryToRow(localSummary() as never, new Map()));
    sdk.pauseAutomation.mockResolvedValue(undefined);
    sdk.getAutomation.mockResolvedValue(
      localSummary({ status: "paused", pausedReason: "manual", nextRunAt: null })
    );
    sdk.listAutomationRuns.mockReturnValue(gen([]));

    const paused = await toggleAutomation("auto-1", "paused");
    expect(sdk.pauseAutomation).toHaveBeenCalledWith("auto-1", expect.objectContaining(AUTH));
    expect(paused.status).toBe("paused");
    expect(paused.paused_reason).toBe("manual");
    expect(paused.next_run_at).toBeNull();
  });
});

describeWithDb("deleteAutomation", () => {
  it("deletes on the platform and cascades the cache", async () => {
    store.upsertAutomation(summaryToRow(localSummary() as never, new Map()));
    store.upsertRuns([runSummaryToRow(runFixture() as never)]);
    sdk.deleteAutomation.mockResolvedValue(undefined);

    await deleteAutomation("auto-1");
    expect(listAutomations()).toHaveLength(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM automation_runs").get()).toEqual({ n: 0 });
  });
});

describeWithDb("runAutomationNow", () => {
  it("triggers a platform fire and seeds the ledger row", async () => {
    store.upsertAutomation(summaryToRow(localSummary() as never, new Map()));
    sdk.triggerAutomation.mockResolvedValue({
      runId: "run-9",
      automationId: "auto-1",
      status: "queued",
    });

    const runId = await runAutomationNow("auto-1");
    expect(runId).toBe("run-9");
    const runs = store.listRuns("auto-1");
    expect(runs[0]).toMatchObject({ id: "run-9", status: "queued", trigger: "manual" });
  });
});

// ============================================================================
// Run adoption
// ============================================================================

describeWithDb("openAutomationRun", () => {
  beforeEach(() => {
    store.upsertAutomation(summaryToRow(localSummary() as never, new Map([[envName, "r1"]])));
    store.upsertRuns([runSummaryToRow(runFixture() as never)]);
    sdk.getSession.mockResolvedValue({
      workspaceId: "agnt-ws-1",
      session: {},
      status: "idle",
      messages: [],
      createdAt: null,
    });
  });

  it("adopts the sandbox into deus rows and is idempotent", async () => {
    const first = await openAutomationRun("run-1");
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

    const second = await openAutomationRun("run-1");
    expect(second).toEqual(first);
    expect(db.prepare("SELECT COUNT(*) AS n FROM workspaces").get()).toEqual({ n: 1 });
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
