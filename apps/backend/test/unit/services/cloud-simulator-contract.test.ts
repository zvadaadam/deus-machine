// Contract test for the cloud:simulator boundary — the twin of
// cloud-env-contract.test.ts.
//
// Deus's CloudSimulator*Schemas are DELIBERATELY loose (open status string,
// unknown fields pass through): the platform deploys continuously while
// desktop builds update slowly, so a strict mirror of the platform's schema
// would turn every new status or field into a client break. This suite pins
// the properties that make that design safe, so a future "cleanup" into a
// strict union fails tests instead of shipping:
//   1. Superset: everything the pinned platform schemas (@deus-hq/api
//      Simulator{Status,Screenshot,ActionResult}EventSchema) can emit parses,
//      as the `data` of the matching cloud:simulator kind.
//   2. Tolerant reader: frames from a NEWER platform than the pin — unknown
//      statuses, unknown fields — still parse, fields preserved.
//   3. The exec response still carries the four fields the driver projects.

import { describe, expect, it } from "vitest";
import {
  SimulatorActionResultEventSchema,
  SimulatorExecResponseEventSchema,
  SimulatorScreenshotEventSchema,
  SimulatorStatusEventSchema,
  type SimulatorActionResultEvent,
  type SimulatorExecResponseEvent,
  type SimulatorScreenshotEvent,
  type SimulatorStatusEvent,
} from "@deus-hq/api";
import {
  CloudSimulatorActionResultSchema,
  CloudSimulatorEventSchema,
  CloudSimulatorScreenshotSchema,
  CloudSimulatorStatusSchema,
} from "@shared/events";

const T = "2026-09-03T10:00:00.000Z";

/** What the driver ships as `data`: the platform frame minus its `type`. */
function minusType<F extends { type: string }>(frame: F): Omit<F, "type"> {
  const { type: _type, ...rest } = frame;
  return rest;
}

function envelope(kind: "status" | "screenshot" | "action_result", data: unknown) {
  return { workspaceId: "deus-ws-1", sessionId: "deus-session-1", kind, data };
}

// One representative frame per status, including the two backend-synthesized
// errors (no device behind them — `platform` absent on the sidecar one).
const STATUS_FRAMES: SimulatorStatusEvent[] = [
  { type: "simulator.status", sessionId: "s-1", status: "starting", platform: "ios", timestamp: T },
  {
    type: "simulator.status",
    sessionId: "s-1",
    status: "ready",
    platform: "ios",
    easSessionIdentifier: "eas-1",
    streamUrl: "https://stream.expo.dev/eas-1",
    timestamp: T,
  },
  {
    type: "simulator.status",
    sessionId: "s-1",
    status: "stopping",
    platform: "android",
    easSessionIdentifier: "eas-2",
    timestamp: T,
  },
  {
    type: "simulator.status",
    sessionId: "s-1",
    status: "stopped",
    platform: "android",
    timestamp: T,
  },
  {
    type: "simulator.status",
    sessionId: "s-1",
    status: "error",
    platform: "ios",
    error: "The simulator is not enabled for this workspace.",
    timestamp: T,
  },
  {
    type: "simulator.status",
    sessionId: "s-1",
    status: "error",
    error:
      "This sandbox's sidecar predates simulator control — restart the workspace to upgrade it.",
    timestamp: T,
  },
];

const SCREENSHOT_FRAMES: SimulatorScreenshotEvent[] = [
  {
    type: "simulator.screenshot",
    sessionId: "s-1",
    platform: "ios",
    imageBase64: "iVBORw0KGgo=",
    format: "png",
    timestamp: T,
  },
];

const ACTION_RESULT_FRAMES: SimulatorActionResultEvent[] = [
  {
    type: "simulator.action_result",
    sessionId: "s-1",
    platform: "ios",
    verb: "press",
    args: ["ref-3"],
    success: true,
    output: "pressed ref-3",
    timestamp: T,
  },
  {
    type: "simulator.action_result",
    sessionId: "s-1",
    platform: "android",
    verb: "screenshot",
    success: false,
    error: "device not ready",
    timestamp: T,
  },
  {
    type: "simulator.action_result",
    sessionId: "s-1",
    platform: "ios",
    verb: "home",
    success: true,
    timestamp: T,
  },
];

describe("cloud:simulator contract", () => {
  it("accepts every status frame the pinned platform schema can emit (superset)", () => {
    for (const frame of STATUS_FRAMES) {
      // Sanity: the sample really is valid platform output for this pin.
      expect(SimulatorStatusEventSchema.safeParse(frame).success).toBe(true);

      const data = minusType(frame);
      expect(
        CloudSimulatorStatusSchema.safeParse(data).success,
        `deus status schema rejected platform frame: ${frame.status}`
      ).toBe(true);
      expect(
        CloudSimulatorEventSchema.safeParse(envelope("status", data)).success,
        `deus event schema rejected platform status: ${frame.status}`
      ).toBe(true);
    }
  });

  it("accepts every screenshot and action-result frame the pin can emit (superset)", () => {
    for (const frame of SCREENSHOT_FRAMES) {
      expect(SimulatorScreenshotEventSchema.safeParse(frame).success).toBe(true);
      const data = minusType(frame);
      expect(CloudSimulatorScreenshotSchema.safeParse(data).success).toBe(true);
      expect(CloudSimulatorEventSchema.safeParse(envelope("screenshot", data)).success).toBe(true);
    }
    for (const frame of ACTION_RESULT_FRAMES) {
      expect(SimulatorActionResultEventSchema.safeParse(frame).success).toBe(true);
      const data = minusType(frame);
      expect(
        CloudSimulatorActionResultSchema.safeParse(data).success,
        `deus action-result schema rejected verb: ${frame.verb}`
      ).toBe(true);
      expect(CloudSimulatorEventSchema.safeParse(envelope("action_result", data)).success).toBe(
        true
      );
    }
  });

  it("accepts frames from a newer platform than the pin (tolerant reader)", () => {
    const future = {
      sessionId: "s-1",
      status: "rebooting", // status deus has never heard of
      platform: "ios",
      bootProgress: 40, // field deus has never heard of
      timestamp: T,
    };
    const parsed = CloudSimulatorEventSchema.safeParse(envelope("status", future));
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.kind === "status") {
      expect(parsed.data.data.status).toBe("rebooting");
      // Loose schema must carry unknown fields through, not strip them.
      expect((parsed.data.data as Record<string, unknown>).bootProgress).toBe(40);
    }
  });

  it("still rejects structurally malformed frames", () => {
    // status is the one field every consumer keys on.
    expect(CloudSimulatorStatusSchema.safeParse({ platform: "ios" }).success).toBe(false);
    expect(CloudSimulatorStatusSchema.safeParse({ status: 7 }).success).toBe(false);
    // A platform outside the closed enum is a pin bump, not a passthrough:
    // the row column and the device frame both key off it.
    expect(
      CloudSimulatorStatusSchema.safeParse({ status: "ready", platform: "visionos" }).success
    ).toBe(false);
    // A screenshot without pixels and an action result without a verdict are useless.
    expect(CloudSimulatorScreenshotSchema.safeParse({ platform: "ios" }).success).toBe(false);
    expect(CloudSimulatorActionResultSchema.safeParse({ verb: "press" }).success).toBe(false);
    // Unknown kinds never reach the store.
    expect(
      CloudSimulatorEventSchema.safeParse({
        workspaceId: "w",
        sessionId: "s",
        kind: "telemetry",
        data: {},
      }).success
    ).toBe(false);
  });

  it("keeps the exec response fields the driver projects (success, exitCode, output, error)", () => {
    const response: SimulatorExecResponseEvent = {
      type: "simulator.exec.response",
      sessionId: "s-1",
      requestId: "req-1",
      verb: "press",
      success: false,
      exitCode: 1,
      output: "",
      error: "no element ref-9",
      timestamp: T,
    };
    const parsed = SimulatorExecResponseEventSchema.safeParse(response);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // The driver returns these four verbatim (a failed verb is a result,
      // not an exception) — the platform must keep carrying them.
      expect(parsed.data).toMatchObject({
        requestId: "req-1",
        success: false,
        exitCode: 1,
        output: "",
        error: "no element ref-9",
      });
    }
  });
});
