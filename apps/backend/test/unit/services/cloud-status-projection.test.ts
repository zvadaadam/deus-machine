import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SCHEMA_SQL } from "@shared/schema";
import { applyCloudStatus } from "../../../src/services/workspace-lifecycle";

let db: Database.Database;
vi.mock("../../../src/lib/database", () => ({ getDatabase: () => db }));
vi.mock("../../../src/services/query-engine", () => ({ invalidate: vi.fn() }));

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  db.exec(`
    INSERT INTO repositories (id, name) VALUES ('repo', 'repo');
    INSERT INTO workspaces (id, repository_id, slug, kind) VALUES ('w','repo','w','cloud'), ('other','repo','other','cloud');
    INSERT INTO sessions (id, workspace_id) VALUES ('chat','w'), ('elsewhere','other');`);
});
afterEach(() => db.close());

const cases = [
  ["running", { status: "running" }, ["ready", null, null, null]],
  [
    "default provisioning",
    { status: "provisioning" },
    ["initializing", "provisioning", null, null],
  ],
  [
    "provisioning step",
    { status: "provisioning", step: "cloning" },
    ["initializing", "cloning", null, null],
  ],
  ["paused", { status: "paused" }, ["ready", "paused", null, null]],
  ["stopped", { status: "stopped" }, ["ready", "stopped", null, null]],
  ["resuming", { status: "resuming" }, ["ready", "resuming", null, null]],
  [
    "specific error",
    { status: "error", errorMessage: "No capacity", reason: "quota", step: "clone" },
    ["error", null, "No capacity", null],
  ],
  [
    "reason",
    { status: "error", errorMessage: " ", reason: "quota", step: "clone" },
    ["error", null, "quota", null],
  ],
  [
    "step",
    { status: "error", errorMessage: "", reason: "", step: "clone" },
    ["error", null, "clone", null],
  ],
  [
    "default error",
    { status: "error" },
    ["error", null, "The cloud computer reported an error.", null],
  ],
] as const;

const unrecognized = [
  ["unknown", { status: "future" }],
  ["missing", {}],
] as const;
const ready = ["ready", "old step", "old reason", "old detail"] as const;
const starting = ["initializing", "old step", "old reason", "old detail"] as const;
const failed = ["error", "old step", "old reason", "old detail"] as const;
const archived = ["archived", "old step", "old reason", "old detail"] as const;

function project(
  data: Parameters<typeof applyCloudStatus>[1],
  before: readonly string[],
  pointer: string | null,
  computer: string | null
) {
  db.prepare(
    "UPDATE workspaces SET state=?, init_stage=?, error_message=?, error_detail=?, current_session_id=?, provider_workspace_id=? WHERE id='w'"
  ).run(...before, pointer, computer);
  applyCloudStatus("w", data);
  return db
    .prepare("SELECT state, init_stage, error_message, error_detail FROM workspaces WHERE id='w'")
    .raw()
    .get();
}

it.each(cases)("projects %s on a visible workspace with its own chat", (_name, data, expected) => {
  for (const before of [ready, starting, failed])
    for (const computer of ["vm", null])
      expect(project(data, before, "chat", computer)).toEqual(expected);
});

it.each(unrecognized)(
  "keeps all four fields for a %s report with a selected chat",
  (_name, data) => {
    for (const before of [ready, starting, failed])
      for (const computer of ["vm", null])
        expect(project(data, before, "chat", computer)).toEqual(before);
  }
);

it.each([
  ["archived with its own chat", archived, "chat"],
  ["archived without a selection", archived, null],
  ["archived with another workspace’s chat", archived, "elsewhere"],
  ["archived with a missing chat", archived, "missing"],
  ["ready without a selection", ready, null],
  ["ready with another workspace’s chat", ready, "elsewhere"],
  ["ready with a missing chat", ready, "missing"],
  ["starting without a selection", starting, null],
  ["starting with another workspace’s chat", starting, "elsewhere"],
  ["starting with a missing chat", starting, "missing"],
  ["failed without a selection", failed, null],
  ["failed with another workspace’s chat", failed, "elsewhere"],
  ["failed with a missing chat", failed, "missing"],
] as const)("keeps a workspace %s for every report", (_name, before, pointer) => {
  for (const [, data] of [...cases, ...unrecognized])
    for (const computer of ["vm", null])
      expect(project(data, before, pointer, computer)).toEqual(before);
});
