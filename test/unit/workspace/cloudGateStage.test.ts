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

  it("gates a failed provision (state error) rather than firing at a dead sidecar", () => {
    // A failed provision keeps its non-sleep init_stage but flips state to
    // "error" — which cloudPresence would misread as awake.
    expect(cloudGateStage(ws({ state: "error", init_stage: "cloning_repository" }))).toBe("error");
    expect(cloudGateStage(ws({ state: "error", init_stage: null }))).toBe("error");
  });

  it("gates a wake-failed ready row (init_stage 'error'/'unhandled') as asleep", () => {
    // The bug: a failed wake persists init_stage "error" on a state="ready" row
    // without a state flip (provider unreachable / resume rejected). The panels
    // must mount the CloudSandboxGate "Wake computer" retry instead of firing
    // at a down sidecar. Covers BOTH Cell A (status null → "error") and Cell B
    // (status "error" → "error"); the backend catch at
    // cloud-workspace-init.service.ts:447 writes "error" for both on a ready
    // row. "unhandled" is the sibling stage parked alongside state="error" —
    // same asleep-equivalent treatment if it ever rides on a ready row.
    expect(cloudGateStage(ws({ state: "ready", init_stage: "error" }))).toBe("asleep");
    expect(cloudGateStage(ws({ state: "ready", init_stage: "unhandled" }))).toBe("asleep");
  });

  it("still gates a state=error row as 'error' even when init_stage is asleep-equivalent", () => {
    // Guard: cloudGateStage's state="error" branch fires BEFORE cloudPresence,
    // so an honestly-errored row (agnt pushed an "error" frame; driver.ts flips
    // state to "error") must show the honest error gate — not the asleep retry
    // — even when init_stage happens to be "error" / "unhandled".
    expect(cloudGateStage(ws({ state: "error", init_stage: "error" }))).toBe("error");
    expect(cloudGateStage(ws({ state: "error", init_stage: "unhandled" }))).toBe("error");
  });

  it("does not gate a ready, awake computer", () => {
    expect(cloudGateStage(ws({ state: "ready", init_stage: null }))).toBeNull();
    expect(cloudGateStage(ws({ state: "ready", init_stage: "running" }))).toBeNull();
  });
});
