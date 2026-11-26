import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createSession } from "@deus-hq/sdk";
import { updateSessionTitle } from "@shared/api/sessions";
import { updateWorkspaceTitle } from "@shared/api/workspaces";
import { SCHEMA_SQL } from "@shared/schema";
import sessions from "../../../src/api/sessions";
import workspaces from "../../../src/api/workspaces";
import * as cloud from "../../../src/services/agent/cloud/driver";
import * as token from "../../../src/services/agent/cloud/session-token";
import * as socket from "../../../src/services/agent/cloud/session-socket";
import { persistSessionTitle } from "../../../src/services/agent/persistence";
import { invalidate } from "../../../src/services/query-engine";
import { operations } from "../../helpers";

let db: Database.Database;
vi.mock("../../../src/lib/database", () => ({ getDatabase: () => db }));
vi.mock("../../../src/services/query-engine", () => ({ invalidate: vi.fn() }));
vi.mock("@deus-hq/sdk", { spy: true });

const run = operations([...sessions, ...workspaces]);
const nameChat = (title: string, sessionId = "s") => run(updateSessionTitle, { sessionId, title });
const nameWorkspace = (title: string, workspaceId = "w") =>
  run(updateWorkspaceTitle, { workspaceId, title });
const titles = () =>
  db
    .prepare(
      "SELECT s.title AS chat, w.title AS workspace FROM sessions s JOIN workspaces w ON w.id = s.workspace_id WHERE s.id = 's'"
    )
    .get();

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  db.exec(`INSERT INTO repositories (id, name) VALUES ('r', 'repo');
    INSERT INTO workspaces (id, repository_id, slug, state) VALUES ('w', 'r', 'lead', 'ready');
    INSERT INTO sessions (id, workspace_id) VALUES ('s', 'w');`);
  vi.mocked(invalidate).mockClear();
});

afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
});

it.each([
  "",
  "   ",
  "two\nlines",
  "\rfirst",
  "last\v",
  "x\u0085y",
  "x\u2028y",
  "x\u2029y",
  "a".repeat(121),
])("refuses the same invalid name on either operation (%j)", async (title) => {
  await expect(nameChat(title)).rejects.toMatchObject({ statusCode: 400 });
  await expect(nameWorkspace(title)).rejects.toMatchObject({ statusCode: 400 });
  expect(titles()).toEqual({ chat: null, workspace: null });
});

it("trims both names, accepts 120 characters and keeps later summaries from replacing them", async () => {
  const title = "🌱".repeat(120);
  await expect(nameChat(`  ${title}  `)).resolves.toEqual({ previousTitle: null });
  expect(invalidate).toHaveBeenCalledExactlyOnceWith(["workspaces", "sessions", "session"], {
    sessionIds: ["s"],
  });
  await nameWorkspace(`  ${title}  `);
  expect(titles()).toEqual({ chat: title, workspace: title });

  await expect(nameChat("Review")).resolves.toEqual({ previousTitle: title });
  await expect(nameWorkspace("Shipping")).resolves.toEqual({ previousTitle: title });
  expect(persistSessionTitle("s", "Late summary").ok).toBe(true);
  expect(titles()).toEqual({ chat: "Review", workspace: "Shipping" });
});

it("refuses a hidden chat and both targets in an archived workspace", async () => {
  db.exec("UPDATE sessions SET is_hidden = 1");
  await expect(nameChat("After archive")).rejects.toMatchObject({ statusCode: 409 });
  db.exec("UPDATE sessions SET is_hidden = 0; UPDATE workspaces SET state = 'archived'");
  await expect(nameChat("After archive")).rejects.toMatchObject({ statusCode: 409 });
  await expect(nameWorkspace("After archive")).rejects.toMatchObject({ statusCode: 409 });
  expect(titles()).toEqual({ chat: null, workspace: null });
  expect(invalidate).not.toHaveBeenCalled();
});

it("refuses a missing chat or workspace", async () => {
  await expect(nameChat("Gone", "missing")).rejects.toMatchObject({ statusCode: 404 });
  await expect(nameWorkspace("Gone", "missing")).rejects.toMatchObject({ statusCode: 404 });
});

it("pushes the trimmed name to the platform only for the cloud chat", async () => {
  vi.stubEnv("DEUS_CLOUD_AGNT_URL", "https://platform.test");
  vi.stubEnv("DEUS_CLOUD_AGNT_API_KEY", "test-key");
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
  const facts = vi.spyOn(cloud, "pushCloudSessionFacts");
  await nameChat("Local");
  expect(fetch).not.toHaveBeenCalled();
  db.exec("UPDATE workspaces SET kind = 'cloud'; UPDATE sessions SET provider_session_id = 'twin'");
  await nameChat("  Cloud  ");
  expect(facts).toHaveBeenLastCalledWith("s", { title: "Cloud" });
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    "https://platform.test/sessions/twin/metadata",
    expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ metadata: { title: "Cloud" } }),
    })
  );
});

it("stamps a title renamed during cloud session creation once the twin is linked", async () => {
  vi.stubEnv("DEUS_CLOUD_AGNT_URL", "https://platform.test");
  vi.stubEnv("DEUS_CLOUD_AGNT_API_KEY", "test-key");
  db.exec("UPDATE workspaces SET kind = 'cloud', provider_workspace_id = 'cloud-workspace'");
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
  vi.mocked(createSession).mockImplementationOnce(async ({ metadata }) => {
    expect(metadata).toEqual({ harness: "claude-code" });
    await nameChat("In review");
    expect(fetch).not.toHaveBeenCalled();
    return { id: "twin", organizationId: "org", userId: "user" };
  });
  vi.spyOn(token, "mintCloudSessionToken").mockResolvedValue({ token: "test", expiresIn: 3600 });
  vi.spyOn(socket, "connectSessionSocket").mockReturnValue({
    ready: async () => {},
    send: vi.fn(),
    close: vi.fn(),
    isOpen: () => true,
  });
  onTestFinished(() => cloud.shutdownCloudDriver());
  await cloud.ensureCloudSession("s");
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    "https://platform.test/sessions/twin/metadata",
    expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ metadata: { harness: "claude-code", title: "In review" } }),
    })
  );
});
