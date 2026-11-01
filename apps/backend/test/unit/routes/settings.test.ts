import { vi, describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { errorHandler } from "../../../src/middleware/error-handler";

vi.mock("../../../src/services/settings.service", () => ({
  getAllSettings: vi.fn(() => ({ theme: "dark", lang: "en" })),
  saveSetting: vi.fn(),
}));
vi.mock("../../../src/services/agent/cloud/models", () => ({
  getCloudModelLists: vi.fn(),
}));

import settingsRoutes from "../../../src/routes/settings";
import { getAllSettings, saveSetting } from "../../../src/services/settings.service";
import { getCloudModelLists } from "../../../src/services/agent/cloud/models";

// Wrap the sub-app with error handler like the real app does
const app = new Hono();
app.route("/", settingsRoutes);
app.onError(errorHandler);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /settings", () => {
  it("returns 200 with settings object", async () => {
    const res = await app.request("/settings");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ theme: "dark", lang: "en" });
  });

  it("calls getAllSettings", async () => {
    await app.request("/settings");
    expect(getAllSettings).toHaveBeenCalled();
  });
});

describe("POST /settings", () => {
  it("returns 200 with success when given key and value", async () => {
    const res = await app.request("/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "theme", value: "light" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, key: "theme", value: "light" });
  });

  it("calls saveSetting with correct arguments", async () => {
    await app.request("/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "theme", value: "light" }),
    });
    expect(saveSetting).toHaveBeenCalledWith("theme", "light");
  });

  it("returns 400 when key is missing", async () => {
    const res = await app.request("/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "light" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when key is empty string", async () => {
    const res = await app.request("/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "", value: "light" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /settings/cloud/models", () => {
  const LISTS = [
    {
      harness: "claude-code",
      source: "catalog",
      fetchedAt: 1,
      models: [
        {
          id: "opus",
          harness: "claude-code",
          label: "Opus 5.5",
          thinking: { levels: ["low", "medium", "high", "xhigh", "max"] },
        },
      ],
    },
  ];

  it("answers the platform's lists as listModels() returns them", async () => {
    vi.mocked(getCloudModelLists).mockResolvedValue(LISTS as never);
    const res = await app.request("/settings/cloud/models");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: true, lists: LISTS });
  });

  it("answers no lists, not an error, without a cloud account to ask", async () => {
    vi.mocked(getCloudModelLists).mockResolvedValue(null);
    const res = await app.request("/settings/cloud/models");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: false, lists: [] });
  });

  it("says what failed when the platform cannot be read", async () => {
    vi.mocked(getCloudModelLists).mockRejectedValue(new Error("Request timed out"));
    const res = await app.request("/settings/cloud/models");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Request timed out" });
  });
});
