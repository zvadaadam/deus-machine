import { describe, expect, it } from "vitest";
import { cloudGateStage } from "@/features/workspace/lib/cloudPresence";

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
    // state "initializing" with any in-flight setup stage → provisioning, even
    // though cloudPresence(init_stage) alone would read "awake".
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

  it("does not gate a ready, awake computer", () => {
    expect(cloudGateStage(ws({ state: "ready", init_stage: null }))).toBeNull();
    expect(cloudGateStage(ws({ state: "ready", init_stage: "running" }))).toBeNull();
  });
});
