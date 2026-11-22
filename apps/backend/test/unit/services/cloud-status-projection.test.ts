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

const keep = null;
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
  ...["paused", "stopped", "resuming"].map(
    (status) => [status, { status }, ["ready", status, null, null]] as const
  ),
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
  ["unknown", { status: "future" }, keep],
  ["missing", {}, keep],
] as const;

it.each(cases)("projects %s for each row shape", (_name, data, projected) => {
  const read = db
    .prepare("SELECT state, init_stage, error_message, error_detail FROM workspaces WHERE id='w'")
    .raw();
  for (const state of ["ready", "initializing", "error", "archived"]) {
    for (const pointer of [null, "elsewhere", "missing", "chat"]) {
      for (const vm of [null, "vm"]) {
        db.prepare(
          "UPDATE workspaces SET state=?, init_stage='old step', error_message='old reason', error_detail='old detail', current_session_id=?, provider_workspace_id=? WHERE id='w'"
        ).run(state, pointer, vm);
        const before = read.get();
        applyCloudStatus("w", data);
        expect
          .soft(read.get(), JSON.stringify({ state, pointer, vm }))
          .toEqual(state === "archived" || pointer !== "chat" || !projected ? before : projected);
      }
    }
  }
});
