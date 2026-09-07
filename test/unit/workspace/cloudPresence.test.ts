import { describe, expect, it } from "vitest";
import { cloudPresence } from "@/features/workspace/lib/cloudPresence";

/**
 * Unit-level vocabulary for `cloudPresence`. Every surface (the sidebar
 * liveness icon, the header chip, the in-panel CloudSandboxGate) derives from
 * this ONE function, so a single misclassification ripples to every surface at
 * once. The cases here are pinned against the producer's `init_stage` writes —
 * see `apps/backend/src/services/cloud-workspace-init.service.ts`
 * (`setStage("resuming" | "paused" | "stopped" | "error" | null)`), the driver
 * mirror (`driver.ts`), and `routes/workspaces.ts` (`init_stage = "unhandled"`
 * alongside `state = "error"`).
 */
describe("cloudPresence", () => {
  it("maps an explicit in-flight resume to waking", () => {
    expect(cloudPresence("resuming")).toBe("waking");
  });

  it("maps paused and stopped to asleep (the wake-on-send sleep states)", () => {
    expect(cloudPresence("paused")).toBe("asleep");
    expect(cloudPresence("stopped")).toBe("asleep");
  });

  it("does not classify a wake-failed init_stage as awake", () => {
    // The bug: a failed wake persists init_stage "error" on a state="ready" row
    // (provider unreachable / resume rejected) WITHOUT a state flip, and
    // "unhandled" is parked alongside state="error" elsewhere. Both must read
    // as asleep so the panels gate to a "Wake computer" retry affordance
    // instead of firing at a sidecar that can't serve — every other value the
    // backend can write into init_stage on a ready row is treated as awake.
    expect(cloudPresence("error")).toBe("asleep");
    expect(cloudPresence("unhandled")).toBe("asleep");
  });

  it("treats no stage / a running stage / an unknown stage as awake", () => {
    // null = nothing parked (or a running frame cleared it); undefined =
    // missing field; "running" / unmodelled strings = awake. A ready row with
    // an awake presence must NOT gate the panels.
    expect(cloudPresence(null)).toBe("awake");
    expect(cloudPresence(undefined)).toBe("awake");
    expect(cloudPresence("running")).toBe("awake");
    expect(cloudPresence("some-unknown-agnt-string")).toBe("awake");
  });
});
