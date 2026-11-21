import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import workspaceOperations from "../../../src/api/workspaces";
import { Registry, LOCAL_CALLER } from "../../../src/api/registry";
import { DeusError } from "@deus-hq/sdk";
import {
  archiveWorkspace,
  unarchiveWorkspace,
  wakeWorkspace,
} from "../../../src/services/workspace-archive.service";
import {
  applyCloudStatus,
  attachCloudComputer,
  attachCloudChat,
  failCloudStart,
} from "../../../src/services/workspace-lifecycle";
import { SCHEMA_SQL } from "@shared/schema";
import {
  createCloudWorkspace,
  retryCloudWorkspace,
} from "../../../src/services/cloud-workspace-init.service";

let db: Database.Database;
const mock = vi.hoisted(() => ({
  invalidate: vi.fn(),
  publicRepo: vi.fn(),
  allocate: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  status: vi.fn(),
  createSession: vi.fn(),
  connect: vi.fn(),
}));
vi.mock("../../../src/lib/database", () => ({ getDatabase: () => db }));
vi.mock("../../../src/services/query-engine", () => ({ invalidate: mock.invalidate }));
vi.mock("../../../src/services/agent/cloud/config", async () =>
  (await import("../../cloud-config-mock")).cloudConfigMock(() => ({
    baseUrl: "https://platform.test",
    apiKey: "key",
    orgId: "org",
    deusCloudUrl: "https://cloud.test",
    deusCloudSessionToken: "session",
  }))
);
vi.mock("../../../src/services/github-remote", () => ({
  mintRepoInstallationToken: async () => ({ definitive: true, token: null }),
  isPublicGithubRepo: mock.publicRepo,
}));
vi.mock("../../../src/services/cloud-settings.service", () => ({
  getCloudWorkspaceUserId: async () => "user",
}));
vi.mock("../../../src/services/cloud-environment.service", () => ({
  getCloudEnvironmentInfo: async () => ({}),
}));
vi.mock("../../../src/services/agent/cloud/driver", () => ({
  ensureCloudSession: mock.connect,
  announceCloudEnv: vi.fn(),
  hasLiveCloudSession: () => false,
  getCloudIdentityGeneration: () => 0,
}));
vi.mock("@deus-hq/sdk", async (original) => ({
  ...(await original<typeof import("@deus-hq/sdk")>()),
  createWorkspace: mock.allocate,
  pauseWorkspace: mock.pause,
  resumeWorkspace: mock.resume,
  getWorkspace: mock.status,
  createSession: mock.createSession,
}));

beforeEach(() => {
  vi.resetAllMocks();
  mock.allocate.mockResolvedValue({ id: "vm" });
  mock.publicRepo.mockResolvedValue(true);
  mock.createSession.mockResolvedValue({ id: "platform-chat" });
  mock.status.mockResolvedValue({ status: "running" });
  db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  db.exec(
    "INSERT INTO repositories (id, name, git_origin_url) VALUES ('r', 'repo', 'https://github.com/acme/repo')"
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  db.close();
});

it("publishes the committed row at create, refusal, retry, computer attachment and chat attachment", async () => {
  // Read what a synchronous subscriber can see, including the chat in the same commit.
  const observed: unknown[] = [];
  const row = db.prepare(`
    SELECT w.state, w.init_stage, w.error_message, w.error_detail, w.init_fetch_issue, w.setup_status,
           w.provider_workspace_id, w.last_inline_mint_at, s.provider_session_id
    FROM workspaces w LEFT JOIN sessions s ON s.id = w.current_session_id`);
  mock.invalidate.mockImplementation(() => observed.push(row.get()));
  mock.publicRepo.mockResolvedValue(false);
  const { workspaceId } = createCloudWorkspace({ repositoryId: "r" });
  await vi.waitFor(() => expect(observed).toHaveLength(2));
  mock.publicRepo.mockResolvedValue(true);
  mock.createSession.mockResolvedValue({ id: "platform-chat" });
  retryCloudWorkspace(workspaceId);
  await vi.waitFor(() => expect(mock.connect).toHaveBeenCalledOnce());

  const creating = {
    state: "initializing",
    init_stage: "creating cloud workspace",
    error_message: null,
    error_detail: null,
    init_fetch_issue: null,
    setup_status: "none",
    provider_workspace_id: null,
    last_inline_mint_at: null,
    provider_session_id: null,
  };
  const attached = {
    ...creating,
    init_stage: "creating cloud session",
    provider_workspace_id: "vm",
    last_inline_mint_at: 0,
  };
  expect(observed).toEqual([
    creating,
    {
      ...creating,
      state: "error",
      error_message:
        "GitHub access required — install the Deus GitHub App for acme/repo to run it in the cloud.",
    },
    creating,
    attached,
    { ...attached, init_stage: "provisioning sandbox", provider_session_id: "platform-chat" },
  ]);
  expect(mock.invalidate.mock.calls).toEqual(
    observed.map(() => [["workspaces", "sessions", "session"], {}])
  );
});

it("keeps the allocated computer and last stage when chat creation fails", async () => {
  mock.publicRepo.mockResolvedValue(true);
  mock.createSession.mockRejectedValue(new Error("chat unavailable"));
  const { workspaceId } = createCloudWorkspace({ repositoryId: "r" });
  await vi.waitFor(() => expect(mock.invalidate).toHaveBeenCalledTimes(3));
  expect(
    db
      .prepare(
        "SELECT state, init_stage, provider_workspace_id, current_session_id, error_message FROM workspaces WHERE id = ?"
      )
      .get(workspaceId)
  ).toEqual({
    state: "error",
    init_stage: "creating cloud session",
    provider_workspace_id: "vm",
    current_session_id: null,
    error_message: "The cloud computer exists, but its chat did not open.",
  });
  expect(mock.invalidate.mock.calls).toEqual(
    Array(3).fill([["workspaces", "sessions", "session"], {}])
  );
  expect(() => retryCloudWorkspace(workspaceId)).toThrow("not waiting for a retry");
  expect(mock.invalidate).toHaveBeenCalledTimes(3);
});

const row = (id: string) => db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id);
const report = (id: string, status: string) =>
  applyCloudStatus(id, { status }, { beforePublish() {} });
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

const windowArchive = (workspaceId: string) =>
  new Registry(workspaceOperations).run(
    "archiveWorkspace",
    "write",
    { workspaceId },
    { caller: LOCAL_CALLER }
  );
const stillStarting = "This cloud workspace is still starting. Archive it once it is ready.";

it.each(["checking access", "allocating", "opening the chat"] as const)(
  "answers archive during %s without waiting for the outstanding start request",
  async (stage) => {
    const gate = Promise.withResolvers<unknown>();
    const held =
      stage === "checking access"
        ? mock.publicRepo
        : stage === "allocating"
          ? mock.allocate
          : mock.createSession;
    held.mockReturnValueOnce(gate.promise);
    const { workspaceId } = createCloudWorkspace({ repositoryId: "r" });
    await vi.waitFor(() => expect(held).toHaveBeenCalledOnce());
    const before = row(workspaceId);
    mock.invalidate.mockClear();
    const answer = vi.fn();
    const closing = Promise.resolve(windowArchive(workspaceId)).then(
      () => answer("archived"),
      (err: Error) => answer(err.message)
    );
    await nextTurn();
    const known = stage === "opening the chat";
    try {
      expect(answer).toHaveBeenCalledWith(known ? "archived" : stillStarting);
      expect(mock.pause).toHaveBeenCalledTimes(known ? 1 : 0);
      if (known) {
        expect(mock.invalidate.mock.calls).toEqual([[["workspaces"]]]);
        expect(row(workspaceId)).toMatchObject({
          state: "archived",
          provider_workspace_id: "vm",
          current_session_id: null,
          archived_by: null,
          archived_at: expect.any(String),
        });
        // Undo opens the same computer's chat even though the retired request has not returned.
        await unarchiveWorkspace(workspaceId);
        const restored = row(workspaceId);
        expect(restored).toMatchObject({ state: "ready", current_session_id: expect.any(String) });
        mock.invalidate.mockClear();
        gate.resolve({ id: "late-chat" });
        await nextTurn();
        expect(row(workspaceId)).toEqual(restored);
        expect(mock.invalidate).not.toHaveBeenCalled();
        expect(db.prepare("SELECT provider_session_id FROM sessions").pluck().all()).toEqual([
          "platform-chat",
        ]);
      } else {
        expect(row(workspaceId)).toEqual(before);
        expect(mock.invalidate).not.toHaveBeenCalled();
      }
    } finally {
      gate.resolve(stage === "checking access" ? true : { id: known ? "late-chat" : "vm" });
      await closing;
      await nextTurn();
    }
    expect(mock.allocate.mock.calls.filter(([call]) => !call.workspaceId)).toHaveLength(1);
    if (!known)
      expect(row(workspaceId)).toMatchObject({
        state: "initializing",
        provider_workspace_id: "vm",
        current_session_id: expect.any(String),
      });
  }
);

it("ignores another token even while the new start is initializing", async () => {
  const reply = Promise.withResolvers<boolean>();
  mock.publicRepo.mockReturnValueOnce(reply.promise);
  const { workspaceId } = createCloudWorkspace({ repositoryId: "r" });
  const before = row(workspaceId);
  const stale = new AbortController().signal;
  const effect = vi.fn();
  mock.invalidate.mockClear();
  try {
    attachCloudComputer(db, workspaceId, "other-vm", 10, effect, stale);
    attachCloudChat(db, workspaceId, "other-chat", stale);
    failCloudStart(db, workspaceId, "other failure", stale);
    expect(row(workspaceId)).toEqual(before);
    expect(mock.invalidate).not.toHaveBeenCalled();
    expect(effect).not.toHaveBeenCalled();
    expect(db.prepare("SELECT id FROM sessions").all()).toEqual([]);
  } finally {
    reply.resolve(true);
    await nextTurn();
  }
});

it("keeps a failed chat repair archived and retries Restore on the same computer", async () => {
  mock.createSession
    .mockRejectedValueOnce(new Error("first refusal"))
    .mockRejectedValueOnce(new Error("second refusal"));
  const { workspaceId } = createCloudWorkspace({ repositoryId: "r" });
  await vi.waitFor(() => expect(row(workspaceId)).toMatchObject({ state: "error" }));
  await archiveWorkspace(workspaceId);
  const snapshots: unknown[] = [];
  mock.invalidate.mockImplementation(() => snapshots.push(row(workspaceId)));
  await expect(unarchiveWorkspace(workspaceId)).rejects.toThrow(
    "The cloud computer exists, but its chat did not open."
  );
  expect(row(workspaceId)).toMatchObject({
    state: "archived",
    current_session_id: null,
    error_detail: "second refusal",
  });
  await unarchiveWorkspace(workspaceId);
  expect(mock.createSession).toHaveBeenCalledTimes(3);
  expect(mock.createSession.mock.calls.every(([request]) => request.workspaceId === "vm")).toBe(
    true
  );
  expect(mock.allocate.mock.calls.filter(([request]) => !request.workspaceId)).toHaveLength(1);
  expect(row(workspaceId)).toMatchObject({
    state: "ready",
    init_stage: null,
    provider_workspace_id: "vm",
    current_session_id: expect.any(String),
    error_message: null,
    error_detail: null,
  });
  expect(snapshots).not.toContainEqual(
    expect.objectContaining({ state: "ready", current_session_id: null })
  );
  expect(mock.connect).toHaveBeenCalledOnce();
});

it.each(["during status read", "during resume", "after wake"] as const)(
  "uses the newer report %s",
  async (when) => {
    const { workspaceId } = createCloudWorkspace({ repositoryId: "r" });
    await vi.waitFor(() => expect(mock.connect).toHaveBeenCalledOnce());
    report(workspaceId, "running");
    mock.status.mockResolvedValue({ status: "paused" });
    const status = Promise.withResolvers<{ status: string }>();
    const resume = Promise.withResolvers<void>();
    if (when === "during status read") mock.status.mockReturnValueOnce(status.promise);
    mock.resume.mockReturnValueOnce(resume.promise);
    const waking = wakeWorkspace(workspaceId);
    if (when === "during status read") {
      await vi.waitFor(() => expect(mock.status).toHaveBeenCalledOnce());
      report(workspaceId, "running");
      status.resolve({ status: "paused" });
    }
    await vi.waitFor(() => expect(mock.resume).toHaveBeenCalledOnce());
    if (when === "during resume") report(workspaceId, "resuming"); // Same stage as the wake's tentative write.
    resume.reject(new Error("old wake failed"));
    expect(await waking).toMatchObject(
      when === "after wake"
        ? { ok: false }
        : { ok: true, status: when === "during resume" ? "resuming" : "running" }
    );
    if (when === "after wake") report(workspaceId, "running");
    expect(row(workspaceId)).toMatchObject({
      state: "ready",
      init_stage: when === "during resume" ? "resuming" : null,
    });
  }
);

it("refuses the first WORKSPACE_STARTING pause immediately and leaves the live list alone", async () => {
  const { workspaceId } = createCloudWorkspace({ repositoryId: "r" });
  await vi.waitFor(() => expect(mock.connect).toHaveBeenCalledOnce());
  const snapshot = row(workspaceId);
  const error = new DeusError("WORKSPACE_STARTING", "starting", 409);
  mock.pause.mockRejectedValueOnce(error);
  mock.invalidate.mockClear();
  vi.useFakeTimers();
  const answer = vi.fn();
  const archiving = archiveWorkspace(workspaceId).then(
    () => answer("archived"),
    (err: Error) => answer(err.message)
  );
  await vi.advanceTimersByTimeAsync(0);
  try {
    expect(answer).toHaveBeenCalledWith(stillStarting);
    expect(row(workspaceId)).toEqual(snapshot);
    expect(mock.invalidate).not.toHaveBeenCalled();
  } finally {
    await vi.advanceTimersByTimeAsync(60_000);
    await archiving;
  }
  expect(mock.pause).toHaveBeenCalledOnce();
  expect(mock.allocate).toHaveBeenCalledOnce();
});

it("joins the initial chat request when a wake arrives before its answer", async () => {
  const reply = Promise.withResolvers<{ id: string }>();
  mock.createSession.mockReturnValueOnce(reply.promise);
  const { workspaceId } = createCloudWorkspace({ repositoryId: "r" });
  await vi.waitFor(() => expect(mock.createSession).toHaveBeenCalledOnce());
  let finished = false;
  const waking = wakeWorkspace(workspaceId).then((result) => {
    finished = true;
    return result;
  });
  await nextTurn();
  const early = finished;
  reply.resolve({ id: "original-chat" });
  expect(await waking).toMatchObject({ ok: true });
  expect(early).toBe(false);
  expect(mock.createSession).toHaveBeenCalledOnce();
  expect(db.prepare("SELECT provider_session_id FROM sessions").pluck().all()).toEqual([
    "original-chat",
  ]);
});

it.each(["running", "provisioning", "resuming", "paused", "stopped", "error"])(
  "uses the newest %s report to settle Restore after either resume outcome",
  async (status) => {
    const comingUp = ["running", "provisioning", "resuming"].includes(status);
    for (const fails of [false, true]) {
      const { workspaceId } = createCloudWorkspace({ repositoryId: "r" });
      await vi.waitFor(() =>
        expect(row(workspaceId)).toMatchObject({ current_session_id: expect.any(String) })
      );
      await archiveWorkspace(workspaceId);
      mock.status.mockResolvedValue({ status: "paused" });
      mock.resume.mockImplementationOnce(async () => {
        report(workspaceId, status);
        if (fails) throw new Error("superseded resume failure");
      });
      const restored = await unarchiveWorkspace(workspaceId).then(
        () => true,
        () => false
      );
      expect.soft(restored).toBe(comingUp);
      expect.soft(row(workspaceId)).toMatchObject({
        state: comingUp ? (status === "provisioning" ? "initializing" : "ready") : "archived",
        current_session_id: expect.any(String),
      });
      if (!comingUp && !restored) {
        mock.resume.mockImplementationOnce(async () => report(workspaceId, "running"));
        await unarchiveWorkspace(workspaceId);
        expect.soft(row(workspaceId)).toMatchObject({ state: "ready" });
      }
    }
  }
);

it("repairs an unarchived failed chat through an explicit wake", async () => {
  mock.createSession.mockRejectedValueOnce(new Error("chat refused"));
  const { workspaceId } = createCloudWorkspace({ repositoryId: "r" });
  await vi.waitFor(() => expect(row(workspaceId)).toMatchObject({ state: "error" }));
  expect(await wakeWorkspace(workspaceId)).toMatchObject({ ok: true });
  expect(row(workspaceId)).toMatchObject({
    state: "ready",
    provider_workspace_id: "vm",
    current_session_id: expect.any(String),
  });
  expect(mock.allocate.mock.calls.filter(([call]) => !call.workspaceId)).toHaveLength(1);
});
