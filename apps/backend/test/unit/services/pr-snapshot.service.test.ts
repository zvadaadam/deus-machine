import Database from "better-sqlite3";
import { SCHEMA_SQL } from "@shared/schema";
import { expect, it, onTestFinished, vi } from "vitest";
import { applyPrStatusSideEffects } from "../../../src/services/pr-snapshot.service";

const { getDatabase, invalidate } = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock("../../../src/lib/database", () => ({ getDatabase }));
vi.mock("../../../src/services/query-engine", () => ({ invalidate }));

it("stamps and publishes the first conclusive no-PR result once", () => {
  const db = new Database(":memory:");
  onTestFinished(() => {
    db.close();
  });
  getDatabase.mockReturnValue(db);
  db.exec(SCHEMA_SQL);
  db.exec(
    "INSERT INTO repositories (id, name) VALUES ('r', 'repo'); INSERT INTO workspaces (id, repository_id, slug) VALUES ('w', 'r', 'workspace')"
  );
  const checkedAt = () =>
    db.prepare("SELECT pr_checked_at FROM workspaces WHERE id = 'w'").pluck().get();
  applyPrStatusSideEffects("w", { has_pr: false, conclusive: false, error: null });
  expect(checkedAt()).toBeNull();
  expect(invalidate).not.toHaveBeenCalled();
  const noPr = { has_pr: false, conclusive: true, error: null };
  applyPrStatusSideEffects("w", noPr);
  expect(checkedAt()).toEqual(expect.any(String));
  db.prepare("UPDATE workspaces SET pr_checked_at = 'earlier' WHERE id = 'w'").run();
  applyPrStatusSideEffects("w", noPr);
  expect(checkedAt()).toBe("earlier");
  expect(invalidate).toHaveBeenCalledOnce();
});
