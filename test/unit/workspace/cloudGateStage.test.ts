import { describe, expect, it } from "vitest";
import { cloudGateStage, cloudPresence } from "@/features/workspace/lib/cloudPresence";

const ws = (o: { kind?: string; state?: string; init_stage?: string | null }) => ({
  kind: o.kind ?? "cloud",
  state: o.state ?? "ready",
  init_stage: o.init_stage ?? null,
});

describe("cloudGateStage", () => {
  it("never gates a local workspace", () => {
    expect(cloudGateStage(ws({ kind: "local", state: "initializing" }))).toBeNull();
  });

  it("gates initial provisioning (the sidecar isn't up yet) — the WebSocket-error case", () => {
    expect(cloudGateStage(ws({ state: "initializing", init_stage: "cloning_repository" }))).toBe(
      "provisioning"
    );
    expect(cloudGateStage(ws({ state: "initializing", init_stage: null }))).toBe("provisioning");
  });

  it("maps the sleep states once ready", () => {
    expect(cloudGateStage(ws({ state: "ready", init_stage: "paused" }))).toBe("asleep");
    expect(cloudGateStage(ws({ state: "ready", init_stage: "stopped" }))).toBe("asleep");
    expect(cloudGateStage(ws({ state: "ready", init_stage: "resuming" }))).toBe("waking");
  });

  it("gates a failed provision (state error) rather than firing at a dead sidecar", () => {
    expect(cloudGateStage(ws({ state: "error", init_stage: "cloning_repository" }))).toBe("error");
    expect(cloudGateStage(ws({ state: "error", init_stage: null }))).toBe("error");
  });

  it.each([
    ["ready", "error", "unavailable"],
    ["error", "error", "error"],
    ["error", "unhandled", "error"],
    ["error", "resuming", "error"],
    ["initializing", "cloning_repository", "provisioning"],
    ["ready", "resuming", "waking"],
    ["ready", "paused", "asleep"],
    ["ready", "stopped", "asleep"],
  ])(
    "keeps header/sidebar presence and the panel gate consistent for %s/%s",
    (state, stage, expected) => {
      const workspace = ws({ state, init_stage: stage });
      expect(cloudPresence(workspace)).toBe(expected);
      expect(cloudGateStage(workspace)).toBe(expected);
    }
  );

  it("recovers a failed wake when the running snapshot clears its stage", () => {
    const workspace = ws({ state: "ready", init_stage: "error" });
    expect(cloudGateStage(workspace)).toBe("unavailable");
    workspace.init_stage = null;
    expect(cloudPresence(workspace)).toBe("awake");
    expect(cloudGateStage(workspace)).toBeNull();
  });

  it("does not gate a ready, awake computer", () => {
    expect(cloudGateStage(ws({ state: "ready", init_stage: null }))).toBeNull();
    expect(cloudGateStage(ws({ state: "ready", init_stage: "running" }))).toBeNull();
  });
});
