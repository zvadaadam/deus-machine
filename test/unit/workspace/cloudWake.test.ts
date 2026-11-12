import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudSandboxGate } from "@/features/workspace/ui/CloudSandboxGate";
import { cloudGateStage } from "@/features/workspace/lib/cloudPresence";
import { wakeCloudWorkspace } from "@/features/workspace/api/wakeCloudWorkspace";
import { api } from "@shared/api";

const mocks = vi.hoisted(() => ({ call: vi.fn(), error: vi.fn() }));
vi.mock("@/platform/ws", () => ({ call: mocks.call }));
vi.mock("sonner", () => ({ toast: { error: mocks.error } }));
beforeEach(() => vi.resetAllMocks());

describe("cloud wake feedback", () => {
  it.each(["rejected", "a failed request"])(
    "reports %s and lets the caller reset its spinner",
    async (failure) => {
      if (failure === "rejected") mocks.call.mockResolvedValue({ ok: false, status: "paused" });
      else mocks.call.mockRejectedValue(new Error("network down"));
      expect(await wakeCloudWorkspace("ws")).toBe(false);
      expect(mocks.call).toHaveBeenCalledExactlyOnceWith(api.wakeCloudWorkspace, {
        workspaceId: "ws",
      });
      expect(mocks.error).toHaveBeenCalledExactlyOnceWith(
        failure === "rejected" ? "Couldn't wake your computer. Try again." : "network down"
      );
    }
  );

  it("distinguishes a failed refresh that retained the live connection", async () => {
    mocks.call.mockResolvedValue({ ok: false, status: "running" });
    expect(await wakeCloudWorkspace("ws")).toBe(false);
    expect(mocks.error).toHaveBeenCalledExactlyOnceWith(
      "Couldn't refresh cloud status. Your existing connection is still available."
    );
  });

  it("shows the cloud's capacity explanation without hiding it behind a generic wake error", async () => {
    const error =
      "This organization already has 10 cloud machines running or starting. Pause or stop one before starting another.";
    mocks.call.mockResolvedValue({ ok: false, status: "paused", error });
    expect(await wakeCloudWorkspace("ws")).toBe(false);
    expect(mocks.error).toHaveBeenCalledExactlyOnceWith(error);
  });

  it("leaves successful wake completion to the workspace status events", async () => {
    mocks.call.mockResolvedValue({ ok: true, status: "resuming" });
    expect(await wakeCloudWorkspace("ws")).toBe(true);
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it("renders failed-wake recovery without turning a setup failure into sleep", () => {
    const render = (state: string) => {
      const stage = cloudGateStage({ kind: "cloud", state, init_stage: "error" });
      return renderToStaticMarkup(
        React.createElement(CloudSandboxGate, { workspaceId: "ws", stage: stage! })
      );
    };
    const unavailable = render("ready");
    expect(unavailable).toContain("Couldn&#x27;t wake your computer");
    expect(unavailable).toMatch(/<button[^>]*>Try again<\/button>/);
    expect(unavailable).not.toContain("asleep");
    const failed = render("error");
    expect(failed).toContain("This computer failed to start");
    expect(failed).not.toContain("<button");
    expect(failed).not.toContain("asleep");
  });
});
