import { describe, expect, it } from "vitest";
import { normalizeUpdateState } from "@/features/updates/hooks/useAutoUpdate";

describe("normalizeUpdateState", () => {
  it("falls back to idle for malformed update states", () => {
    expect(normalizeUpdateState(undefined)).toEqual({ stage: "idle" });
    expect(normalizeUpdateState(null)).toEqual({ stage: "idle" });
    expect(normalizeUpdateState({})).toEqual({ stage: "idle" });
    expect(normalizeUpdateState({ stage: undefined })).toEqual({ stage: "idle" });
    expect(normalizeUpdateState({ stage: "unknown" })).toEqual({ stage: "idle" });
  });

  it("keeps known update states within the renderer union", () => {
    expect(normalizeUpdateState({ stage: "idle", extra: true })).toEqual({ stage: "idle" });
    expect(normalizeUpdateState({ stage: "checking" })).toEqual({ stage: "checking" });
    expect(normalizeUpdateState({ stage: "downloading", progress: { percent: 42 } })).toEqual({
      stage: "downloading",
    });
    expect(
      normalizeUpdateState({
        stage: "ready",
        version: "0.3.7",
        releaseNotes: "Bug fixes",
      })
    ).toEqual({
      stage: "ready",
      version: "0.3.7",
      releaseNotes: "Bug fixes",
    });
    expect(normalizeUpdateState({ stage: "error", error: "Network failed" })).toEqual({
      stage: "error",
      error: "Network failed",
    });
  });

  it("normalizes optional ready and error fields", () => {
    expect(normalizeUpdateState({ stage: "ready", version: 123, releaseNotes: false })).toEqual({
      stage: "ready",
      version: undefined,
      releaseNotes: undefined,
    });
    expect(normalizeUpdateState({ stage: "error" })).toEqual({
      stage: "error",
      error: "Unknown update error",
    });
  });
});
