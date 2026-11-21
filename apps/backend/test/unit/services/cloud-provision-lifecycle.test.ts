import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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

it.each(["before allocation", "allocation", "chat"] as const)(
  "keeps an archive made during %s when the platform answers late",
  async (stage) => {
    const gate = Promise.withResolvers<unknown>();
    const held =
      stage === "before allocation"
        ? mock.publicRepo
        : stage === "allocation"
          ? mock.allocate
          : mock.createSession;
    held.mockReturnValueOnce(gate.promise);
    const { workspaceId } = createCloudWorkspace({ repositoryId: "r" });
    await vi.waitFor(() => expect(held).toHaveBeenCalledOnce());
    const by = { kind: "session", sessionId: "archiver" } as const;
    const closing = archiveWorkspace(workspaceId, undefined, by);
    await vi.waitFor(() => expect(row(workspaceId)).toMatchObject({ state: "archived" }));
    const archivedAt = db
      .prepare("SELECT archived_at FROM workspaces WHERE id = ?")
      .pluck()
      .get(workspaceId);
    mock.invalidate.mockClear();
    // Another retired start cannot supply its computer to this archive.
    attachCloudComputer(db, workspaceId, "unrelated-vm", null, vi.fn(), AbortSignal.abort());
    gate.resolve(
      stage === "before allocation" ? true : { id: stage === "allocation" ? "vm" : "platform-chat" }
    );
    await closing;
    await nextTurn();
    const hasVM = stage !== "before allocation";
    expect(row(workspaceId)).toMatchObject({
      archived_at: archivedAt,
      archived_by: JSON.stringify(by),
      state: "archived",
      current_session_id: null,
      error_message: null,
      provider_workspace_id: hasVM ? "vm" : null,
      init_stage: stage === "chat" ? "creating cloud session" : "creating cloud workspace",
    });
    expect(archivedAt).toEqual(expect.any(String));
    expect(mock.allocate).toHaveBeenCalledTimes(hasVM ? 1 : 0);
    expect(mock.pause).toHaveBeenCalledTimes(hasVM ? 1 : 0);
    expect(mock.createSession).toHaveBeenCalledTimes(stage === "chat" ? 1 : 0);
    expect(db.prepare("SELECT id FROM sessions").all()).toEqual([]);
    expect(mock.connect).not.toHaveBeenCalled();
    if (stage !== "allocation") expect(mock.invalidate).not.toHaveBeenCalled();
  }
);

it("ignores a late failed Retry after archive", async () => {
  mock.allocate.mockRejectedValueOnce(new Error("offline"));
  const { workspaceId } = createCloudWorkspace({ repositoryId: "r" });
  await vi.waitFor(() => expect(row(workspaceId)).toMatchObject({ state: "error" }));
  const reply = Promise.withResolvers<never>();
  mock.allocate.mockReturnValueOnce(reply.promise);
  retryCloudWorkspace(workspaceId);
  await vi.waitFor(() => expect(mock.allocate).toHaveBeenCalledTimes(2));
  const closing = archiveWorkspace(workspaceId);
  await vi.waitFor(() => expect(row(workspaceId)).toMatchObject({ state: "archived" }));
  mock.invalidate.mockClear();
  reply.reject(new Error("old failure"));
  await closing;
  await nextTurn();
  expect(row(workspaceId)).toMatchObject({ state: "archived", error_message: null });
  expect(mock.invalidate).not.toHaveBeenCalled();
});

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

it.each(["confirm", "expire"])(
  "records a late computer before retrying its pause until %s",
  async (outcome) => {
    const reply = Promise.withResolvers<{ id: string }>();
    mock.allocate.mockReturnValueOnce(reply.promise);
    const starting = new DeusError("WORKSPACE_STARTING", "starting", 409);
    mock.pause.mockRejectedValue(starting);
    if (outcome === "confirm")
      mock.pause
        .mockRejectedValueOnce(starting)
        .mockRejectedValueOnce(starting)
        .mockResolvedValue(undefined);
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { workspaceId } = createCloudWorkspace({ repositoryId: "r" });
    await vi.waitFor(() => expect(mock.allocate).toHaveBeenCalledOnce());
    const closing = archiveWorkspace(workspaceId);
    await vi.waitFor(() => expect(row(workspaceId)).toMatchObject({ state: "archived" }));
    vi.useFakeTimers();
    reply.resolve({ id: "late-vm" });
    await vi.advanceTimersByTimeAsync(0);
    expect(row(workspaceId)).toMatchObject({
      state: "archived",
      provider_workspace_id: "late-vm",
      current_session_id: null,
    });
    expect(mock.pause).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(600_000);
    await closing;
    const calls = mock.pause.mock.calls.length;
    expect(calls).toBeGreaterThan(1);
    expect(mock.pause.mock.calls.every(([vm]) => vm === "late-vm")).toBe(true);
    if (outcome === "confirm") expect(calls).toBe(3);
    else
      expect(log.mock.calls.filter((args) => args.join(" ").includes(workspaceId))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mock.pause).toHaveBeenCalledTimes(calls);
    expect(mock.createSession).not.toHaveBeenCalled();
  }
);

it("repairs a failed first chat through restore then wake on the original computer", async () => {
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
    state: "error",
    current_session_id: null,
    error_detail: "second refusal",
  });
  expect(await wakeWorkspace(workspaceId)).toMatchObject({ ok: true });
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

it("waits for a known provisioning computer to accept its pause before archiving it", async () => {
  const { workspaceId } = createCloudWorkspace({ repositoryId: "r" });
  await vi.waitFor(() => expect(mock.connect).toHaveBeenCalledOnce());
  vi.useFakeTimers();
  mock.pause.mockRejectedValueOnce(new DeusError("WORKSPACE_STARTING", "starting", 409));
  const archiving = archiveWorkspace(workspaceId).then(
    () => null,
    (err: unknown) => err
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(row(workspaceId)).toMatchObject({ state: "initializing" });
  await vi.advanceTimersByTimeAsync(1000);
  expect(await archiving).toBeNull();
  report(workspaceId, "running");
  expect(row(workspaceId)).toMatchObject({ state: "archived", provider_workspace_id: "vm" });
  expect(mock.pause).toHaveBeenCalledTimes(2);
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

it("keeps a running report that arrives before restore's failed resume response", async () => {
  const { workspaceId } = createCloudWorkspace({ repositoryId: "r" });
  await vi.waitFor(() => expect(mock.connect).toHaveBeenCalledOnce());
  await archiveWorkspace(workspaceId);
  mock.status.mockResolvedValue({ status: "paused" });
  mock.resume.mockImplementation(async () => {
    report(workspaceId, "running");
    throw new Error("resume failed");
  });
  await unarchiveWorkspace(workspaceId);
  expect(row(workspaceId)).toMatchObject({ state: "ready", init_stage: null, error_message: null });
});
