import { vi, describe, it, expect, beforeEach } from "vitest";
import * as api from "@shared/api/workspaces";
import { operations } from "../../helpers";
import { resetStatsCache } from "../../../src/db/queries";

const mockStmt = {
  get: vi.fn(() => ({
    workspaces: 42,
    workspaces_ready: 42,
    workspaces_archived: 42,
    repos: 42,
    sessions: 42,
    sessions_idle: 42,
    sessions_working: 42,
    messages: 42,
  })),
};
const mockDb = { prepare: vi.fn(() => mockStmt) };

vi.mock("../../../src/lib/database", () => ({
  getDatabase: vi.fn(() => mockDb),
}));

import workspaceHandlers from "../../../src/api/workspaces";

const run = operations(workspaceHandlers);

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.prepare.mockReturnValue(mockStmt);
  resetStatsCache();
});

describe("stats", () => {
  it("answers every count", async () => {
    expect(await run(api.stats)).toEqual({
      workspaces: 42,
      workspaces_ready: 42,
      workspaces_archived: 42,
      repos: 42,
      sessions: 42,
      sessions_idle: 42,
      sessions_working: 42,
      messages: 42,
    });
  });

  it("reads them in one consolidated query", async () => {
    await run(api.stats);
    expect(mockDb.prepare).toHaveBeenCalledTimes(1);
  });
});
