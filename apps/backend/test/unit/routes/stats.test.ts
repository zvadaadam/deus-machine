import { vi, describe, it, expect, beforeEach } from "vitest";
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

import app from "../../../src/routes/stats";

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.prepare.mockReturnValue(mockStmt);
  resetStatsCache();
});

describe("GET /stats", () => {
  it("returns 200 with all 8 count fields", async () => {
    const res = await app.request("/stats");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("workspaces");
    expect(body).toHaveProperty("workspaces_ready");
    expect(body).toHaveProperty("workspaces_archived");
    expect(body).toHaveProperty("repos");
    expect(body).toHaveProperty("sessions");
    expect(body).toHaveProperty("sessions_idle");
    expect(body).toHaveProperty("sessions_working");
    expect(body).toHaveProperty("messages");
  });

  it("returns 42 for all fields from mock", async () => {
    const res = await app.request("/stats");
    const body = await res.json();
    expect(body.workspaces).toBe(42);
    expect(body.workspaces_ready).toBe(42);
    expect(body.workspaces_archived).toBe(42);
    expect(body.repos).toBe(42);
    expect(body.sessions).toBe(42);
    expect(body.sessions_idle).toBe(42);
    expect(body.sessions_working).toBe(42);
    expect(body.messages).toBe(42);
  });

  it("calls db.prepare once with a single consolidated query", async () => {
    await app.request("/stats");
    expect(mockDb.prepare).toHaveBeenCalledTimes(1);
  });
});
