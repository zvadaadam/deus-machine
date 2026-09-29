import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_SQL } from "@shared/schema";

const mocks = vi.hoisted(() => ({ db: undefined as Database.Database | undefined }));
vi.mock("../../../src/lib/database", () => ({ getDatabase: () => mocks.db }));
import { assertUnmanagedWorkspace } from "../../../src/services/managed-workspace";
import { adoptRunRows, reviveAdoptedWorkspace } from "../../../src/services/automations/store";
import {
  getAllWorkspaces,
  getDashboardWorkspaces,
  getWorkspacesByRepo,
  getWorkspaceById,
  getWorkspaceForMiddleware,
  getWorkspacesBySessionIds,
} from "../../../src/db/queries";

beforeEach(() => {
  mocks.db = new Database(":memory:");
  mocks.db.pragma("foreign_keys = ON");
  mocks.db.exec(SCHEMA_SQL);
  mocks.db.exec(`
    INSERT INTO repositories (id, name, root_path) VALUES ('repo', 'Repository', '/fixture');
    INSERT INTO workspaces (id, repository_id, slug, current_session_id, provider_workspace_id)
      VALUES ('agent', 'repo', 'agent', 'current', 'provider-workspace'),
             ('standalone', 'repo', 'standalone', NULL, NULL);
    INSERT INTO sessions (id, workspace_id, provider_session_id)
      VALUES ('current', 'agent', 'provider-session');
    INSERT INTO projects (id, creation_request_id, creation_hash, title, repository_id, model,
      dispatch_limit, concurrency_limit, created_at, updated_at)
      VALUES ('project', 'create', 'hash', 'Project', 'repo', 'model', 10, 1, 0, 0);
    INSERT INTO project_agents (agent_id, project_id, creation_operation_id, created_at)
      VALUES ('agent', 'project', 'operation', 0);
  `);
});
afterEach(() => mocks.db?.close());

describe("managed workspace ownership", () => {
  it("carries Project identity in full lists, individual reads and session deltas", () => {
    const database = mocks.db!;
    const all = [
      getAllWorkspaces(database),
      getDashboardWorkspaces(database),
      getWorkspacesByRepo(database),
    ];
    for (const rows of all) {
      expect(rows.find((row) => row.id === "agent")).toMatchObject({
        project_id: "project",
        project_title: "Project",
      });
      expect(rows.find((row) => row.id === "standalone")).toMatchObject({
        project_id: null,
        project_title: null,
      });
    }
    expect(getWorkspaceById(database, "agent")).toMatchObject({ project_id: "project" });
    expect(getWorkspaceForMiddleware(database, "agent")).toMatchObject({ project_id: "project" });
    expect(getWorkspacesBySessionIds(database, ["current"])).toEqual([
      expect.objectContaining({ project_id: "project", project_title: "Project" }),
    ]);
  });
  it("preserves standalone lifecycle and gives managed actions their Project identity", () => {
    expect(() => assertUnmanagedWorkspace("standalone")).not.toThrow();
    expect(() => assertUnmanagedWorkspace("agent")).toThrow(
      expect.objectContaining({ statusCode: 409, details: { projectId: "project" } })
    );
  });

  it("does not let repository or workspace deletion cascade away managed history", () => {
    expect(() => mocks.db!.prepare("DELETE FROM workspaces WHERE id = 'agent'").run()).toThrow();
    expect(() => mocks.db!.prepare("DELETE FROM repositories WHERE id = 'repo'").run()).toThrow();
    expect(mocks.db!.prepare("SELECT id FROM sessions").all()).toEqual([{ id: "current" }]);
  });

  it.each(["provider-session", "another-provider-session"])(
    "refuses automation adoption through existing session or workspace (%s)",
    (providerSessionId) => {
      expect(() =>
        adoptRunRows({
          runId: "run",
          automationId: "automation",
          repositoryId: "repo",
          automationName: "Automation",
          providerSessionId,
          providerWorkspaceId: "provider-workspace",
          newWorkspaceSlug: () => "new",
        })
      ).toThrow("managed by a Project");
      expect(mocks.db!.prepare("SELECT id FROM sessions").all()).toEqual([{ id: "current" }]);
      expect(
        mocks.db!.prepare("SELECT current_session_id FROM workspaces WHERE id = 'agent'").get()
      ).toEqual({ current_session_id: "current" });
    }
  );

  it("refuses automation revival before changing archived state or the current conversation", () => {
    mocks.db!.prepare("UPDATE workspaces SET state = 'archived' WHERE id = 'agent'").run();
    expect(() => reviveAdoptedWorkspace("agent", "replacement")).toThrow("managed by a Project");
    expect(
      mocks.db!.prepare("SELECT state, current_session_id FROM workspaces WHERE id = 'agent'").get()
    ).toEqual({ state: "archived", current_session_id: "current" });
  });
});
