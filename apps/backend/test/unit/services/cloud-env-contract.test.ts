// Contract test for the cloud:env boundary.
//
// Deus's CloudEnvStateSchema is DELIBERATELY loose (open status string,
// unknown fields pass through): the platform deploys continuously while
// desktop builds update slowly, so a strict union here would turn every new
// platform status/step/field into a client break. This suite pins the two
// properties that make that design safe, so a future "cleanup" into a strict
// enum fails tests instead of shipping:
//   1. Superset: everything the pinned platform schema (@deus-hq/api
//      WorkspaceStateDataSchema) can emit parses successfully.
//   2. Tolerant reader: frames from a NEWER platform than the pin — unknown
//      statuses, unknown fields — still parse, fields preserved.

import { describe, expect, it } from "vitest";
import { WorkspaceStateDataSchema, type WorkspaceStateData } from "@deus-hq/api";
import { CloudEnvStateSchema } from "@shared/events";

// One representative frame per member of the platform's discriminated union.
const PLATFORM_FRAMES: WorkspaceStateData[] = [
  {
    status: "running",
    sandboxId: "sbx-1",
    sandboxUrlTemplate: "https://{{port}}-sbx-1.e2b.dev",
    snapshotRestored: true,
  },
  { status: "running", sandboxId: "sbx-1", sandboxUrlTemplate: null },
  { status: "provisioning", step: "cloning_repository", sandboxId: "sbx-1" },
  { status: "provisioning" },
  { status: "error", reason: "sidecar_unreachable", errorMessage: "boom" },
  { status: "error" },
  { status: "stopped", reason: "idle_timeout" },
  { status: "paused", reason: "manual" },
  { status: "paused" },
];

describe("cloud:env contract", () => {
  it("accepts every frame the pinned platform schema can emit (superset)", () => {
    for (const frame of PLATFORM_FRAMES) {
      // Sanity: the sample really is valid platform output for this pin.
      expect(WorkspaceStateDataSchema.safeParse(frame).success).toBe(true);

      const parsed = CloudEnvStateSchema.safeParse(frame);
      expect(parsed.success, `deus schema rejected platform frame: ${frame.status}`).toBe(true);
    }
  });

  it("accepts frames from a newer platform than the pin (tolerant reader)", () => {
    const future = {
      status: "hibernating", // status deus has never heard of
      step: "warming_cache", // step deus has never heard of
      progressPercent: 62, // field deus has never heard of
    };
    const parsed = CloudEnvStateSchema.safeParse(future);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.status).toBe("hibernating");
      expect(parsed.data.step).toBe("warming_cache");
      // Loose schema must carry unknown fields through, not strip them.
      expect((parsed.data as Record<string, unknown>).progressPercent).toBe(62);
    }
  });

  it("still rejects structurally malformed frames", () => {
    expect(CloudEnvStateSchema.safeParse({ step: "cloning_repository" }).success).toBe(false);
    expect(CloudEnvStateSchema.safeParse({ status: 7 }).success).toBe(false);
    expect(CloudEnvStateSchema.safeParse({ status: "running", step: 42 }).success).toBe(false);
  });
});
