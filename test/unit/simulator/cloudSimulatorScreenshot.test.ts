import { describe, expect, it } from "vitest";
import {
  CAPTURE_AFTER_ANSWER_MS,
  CAPTURE_BEFORE_ANSWER_MS,
  captureAnswersAsk,
  parsePlatformTime,
} from "@/features/simulator/cloud/cloudSimulatorScreenshot";

const T = Date.parse("2026-09-04T10:00:00.000Z");
const ask = { askedAt: 5_000, platform: "ios" as const, answered: true, respondedAt: T };

describe("captureAnswersAsk — the platform's clocks decide", () => {
  it("accepts the capture the platform stamped just before its answer", () => {
    expect(captureAnswersAsk(ask, { at: 5_100, capturedAt: T - 800, platform: "ios" })).toBe(true);
  });

  it("rejects the agent's older capture delivered late, whatever this clock says", () => {
    const stale = {
      at: 5_200,
      capturedAt: T - CAPTURE_BEFORE_ANSWER_MS - 1,
      platform: "ios" as const,
    };
    expect(captureAnswersAsk(ask, stale)).toBe(false);
  });

  it("rejects a capture stamped after the answer — that is a later capture", () => {
    const later = {
      at: 5_300,
      capturedAt: T + CAPTURE_AFTER_ANSWER_MS + 1,
      platform: "ios" as const,
    };
    expect(captureAnswersAsk(ask, later)).toBe(false);
  });

  it("waits for the answer: nothing is proven until the platform has answered the exec", () => {
    expect(
      captureAnswersAsk(
        { ...ask, answered: false },
        { at: 5_100, capturedAt: T - 100, platform: "ios" }
      )
    ).toBe(false);
  });

  it("ignores the other platform's capture", () => {
    expect(captureAnswersAsk(ask, { at: 5_100, capturedAt: T - 100, platform: "android" })).toBe(
      false
    );
  });

  it("falls back to arrival order when a side is unstamped by the platform", () => {
    expect(
      captureAnswersAsk(
        { ...ask, respondedAt: null },
        { at: 5_100, capturedAt: T, platform: "ios" }
      )
    ).toBe(true);
    expect(captureAnswersAsk(ask, { at: 4_000, capturedAt: null, platform: "ios" })).toBe(false);
    expect(captureAnswersAsk(ask, { at: 6_000, capturedAt: null, platform: null })).toBe(true);
  });

  it("parses the platform's stamp and nothing else", () => {
    expect(parsePlatformTime("2026-09-04T10:00:00.000Z")).toBe(T);
    expect(parsePlatformTime("yesterday")).toBeNull();
    expect(parsePlatformTime(undefined)).toBeNull();
  });
});
