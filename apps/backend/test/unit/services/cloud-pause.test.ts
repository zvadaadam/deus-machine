import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DeusError } from "@deus-hq/sdk";
import { errorHandler } from "../../../src/middleware/error-handler";
import { pauseCloudWorkspace } from "../../../src/services/cloud-workspace-init.service";

const pause = vi.hoisted(() => vi.fn());
vi.mock("@deus-hq/sdk", async (original) => ({
  ...(await original<typeof import("@deus-hq/sdk")>()),
  pauseWorkspace: pause,
}));
vi.mock("../../../src/services/agent/cloud/config", () => ({
  getCloudConfig: () => ({ baseUrl: "https://cloud.test", apiKey: "test-key" }),
  setCloudConnectHook: vi.fn(),
}));

const app = new Hono().post("/pause", async (c) => {
  await pauseCloudWorkspace("test-workspace");
  return c.json({ ok: true });
});
app.onError(errorHandler);

beforeEach(() => vi.resetAllMocks());

describe("cloud pause error boundary", () => {
  it("preserves the state conflict and gives the desktop an actionable message", async () => {
    pause.mockRejectedValue(
      new DeusError(
        "WORKSPACE_STARTING",
        "WORKSPACE_STARTING: Cloud machine is still starting",
        409
      )
    );
    const response = await app.request("/pause", { method: "POST" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "The cloud computer is still starting. Try archiving it once it is ready.",
    });
    expect(pause).toHaveBeenCalledOnce();
  });

  it("does not relabel an unrelated cloud failure as a startup conflict", async () => {
    const error = new DeusError("AUTHENTICATION_FAILED", "Invalid key", 401);
    pause.mockRejectedValue(error);
    await expect(pauseCloudWorkspace("test-workspace")).rejects.toBe(error);
  });
});
