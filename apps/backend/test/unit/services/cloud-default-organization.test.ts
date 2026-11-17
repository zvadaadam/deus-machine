// Rows with no organization are given the default one (the platform's first, as the
// desktop pushes it) once, so a later change of the platform's order moves nothing.
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_SQL } from "@shared/schema";

let canUseDatabase = true;
try {
  new Database(":memory:").close();
} catch {
  canUseDatabase = false;
}
const describeWithDb = canUseDatabase ? describe : describe.skip;

const { mockGetDatabase, mockInvalidate } = vi.hoisted(() => ({
  mockGetDatabase: vi.fn(),
  mockInvalidate: vi.fn(),
}));
vi.mock("../../../src/lib/database", () => ({ getDatabase: mockGetDatabase }));
vi.mock("../../../src/services/query-engine", () => ({ invalidate: mockInvalidate }));

import { stampDefaultOrganization } from "../../../src/services/cloud-settings.service";
import {
  resetCloudConfigForTests,
  setCloudRuntimeCredentials,
} from "../../../src/services/agent/cloud/config";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  mockGetDatabase.mockReturnValue(db);
  mockInvalidate.mockReset();
  resetCloudConfigForTests();
  db.prepare(
    "INSERT INTO repositories (id, name, root_path, git_origin_url) VALUES ('r1', 'widgets', NULL, 'https://github.com/acme/widgets')"
  ).run();
  const workspace = db.prepare(
    "INSERT INTO workspaces (id, repository_id, slug, kind, organization_id) VALUES (?, 'r1', ?, ?, ?)"
  );
  workspace.run("w-none", "w-none", "cloud", null);
  workspace.run("w-b", "w-b", "cloud", "org_b");
  workspace.run("w-local", "w-local", "worktree", null);
  const automation = db.prepare(
    "INSERT INTO automations (id, name, prompt, environment, organization_id) VALUES (?, ?, 'p', 'env', ?)"
  );
  automation.run("a-none", "a-none", null);
  automation.run("a-b", "a-b", "org_b");
});

afterEach(() => {
  db.close();
  resetCloudConfigForTests();
});

const workspaces = () =>
  Object.fromEntries(
    (
      db.prepare("SELECT id, organization_id FROM workspaces").all() as Array<{
        id: string;
        organization_id: string | null;
      }>
    ).map((row) => [row.id, row.organization_id])
  );
const automations = () =>
  Object.fromEntries(
    (
      db.prepare("SELECT id, organization_id FROM automations").all() as Array<{
        id: string;
        organization_id: string | null;
      }>
    ).map((row) => [row.id, row.organization_id])
  );

describeWithDb("stampDefaultOrganization", () => {
  it("does nothing while no default organization is known", () => {
    setCloudRuntimeCredentials({ apiKey: "agnt_sk_dev" });
    stampDefaultOrganization();
    expect(workspaces()).toEqual({ "w-none": null, "w-b": "org_b", "w-local": null });
    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  it("gives cloud rows with none the pushed default once; a later default moves nothing", () => {
    // The default's own key is missing: it is still the default the rows are given.
    setCloudRuntimeCredentials({ orgKeys: { org_b: "key_b" }, orgId: "org_a" });
    stampDefaultOrganization();
    expect(workspaces()).toEqual({ "w-none": "org_a", "w-b": "org_b", "w-local": null });
    expect(automations()).toEqual({ "a-none": "org_a", "a-b": "org_b" });
    expect(mockInvalidate).toHaveBeenCalledWith(["workspaces"]);
    expect(mockInvalidate).toHaveBeenCalledWith(["automations"]);

    // The platform's order changes (the account joined an older organization).
    mockInvalidate.mockReset();
    setCloudRuntimeCredentials({ orgKeys: { org_c: "key_c", org_b: "key_b" }, orgId: "org_c" });
    stampDefaultOrganization();
    expect(workspaces()).toEqual({ "w-none": "org_a", "w-b": "org_b", "w-local": null });
    expect(automations()).toEqual({ "a-none": "org_a", "a-b": "org_b" });
    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  it("leaves a stamped workspace to its snapshot's correction", () => {
    setCloudRuntimeCredentials({ orgKeys: { org_a: "key_a" }, orgId: "org_a" });
    stampDefaultOrganization();
    // The cloud driver's write when a snapshot names the workspace's organization.
    db.prepare(
      "UPDATE workspaces SET organization_id = ? WHERE id = ? AND kind = 'cloud' AND organization_id IS NOT ?"
    ).run("org_b", "w-none", "org_b");
    stampDefaultOrganization();
    expect(workspaces()["w-none"]).toBe("org_b");
  });
});
