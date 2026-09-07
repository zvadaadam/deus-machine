import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudSandboxGate } from "@/features/workspace/ui/CloudSandboxGate";
import { cloudGateStage } from "@/features/workspace/lib/cloudPresence";
import { wakeCloudWorkspace } from "@/features/workspace/api/wakeCloudWorkspace";

const mocks = vi.hoisted(() => ({ post: vi.fn(), error: vi.fn() }));
vi.mock("@/shared/api/client", () => ({ apiClient: { post: mocks.post } }));
vi.mock("sonner", () => ({ toast: { error: mocks.error } }));
beforeEach(() => vi.resetAllMocks());

describe("cloud wake feedback", () => {
  it.each(["rejected", "http failure"])(
    "reports %s and lets the caller reset its spinner",
    async (failure) => {
      if (failure === "rejected") mocks.post.mockResolvedValue({ ok: false, status: "paused" });
      else mocks.post.mockRejectedValue(new Error("network down"));
      expect(await wakeCloudWorkspace("ws")).toBe(false);
      expect(mocks.post).toHaveBeenCalledExactlyOnceWith("/workspaces/ws/cloud-wake");
      expect(mocks.error).toHaveBeenCalledExactlyOnceWith(
        "Couldn't wake your computer. Try again."
      );
    }
  );

  it("distinguishes a failed refresh that retained the live connection", async () => {
    mocks.post.mockResolvedValue({ ok: false, status: "running" });
    expect(await wakeCloudWorkspace("ws")).toBe(false);
    expect(mocks.error).toHaveBeenCalledExactlyOnceWith(
      "Couldn't refresh cloud status. Your existing connection is still available."
    );
  });

  it("leaves successful wake completion to the workspace status events", async () => {
    mocks.post.mockResolvedValue({ ok: true, status: "resuming" });
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
