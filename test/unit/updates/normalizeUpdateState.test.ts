import { describe, expect, it } from "vitest";
import { normalizeUpdateState } from "@/features/updates/hooks/useAutoUpdate";

describe("normalizeUpdateState", () => {
  it("keeps valid update states and string metadata", () => {
    expect(
      normalizeUpdateState({
        stage: "ready",
        version: "0.3.7",
        releaseNotes: "Bug fixes",
        error: 42,
      })
    ).toEqual({
      stage: "ready",
      version: "0.3.7",
      releaseNotes: "Bug fixes",
      error: undefined,
    });
  });

  it("falls back to idle for missing or unknown stages", () => {
    expect(normalizeUpdateState(undefined)).toEqual({ stage: "idle" });
    expect(normalizeUpdateState({})).toEqual({ stage: "idle" });
    expect(normalizeUpdateState({ stage: "queued" })).toEqual({ stage: "idle" });
  });
});
