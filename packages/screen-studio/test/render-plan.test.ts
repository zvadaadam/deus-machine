import { describe, it, expect } from "vitest";
import {
  createPlaybackPlan,
  isMeaningfulAction,
  sourceToOutputTime,
  outputToSourceTime,
  DEFAULT_SPEED_RAMP_CONFIG,
} from "../src/recorder/render-plan";
import type { AgentEvent } from "../src/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(type: AgentEvent["type"], t: number, x = 500, y = 300): AgentEvent {
  return { type, t, x, y };
}

// ---------------------------------------------------------------------------
// isMeaningfulAction
// ---------------------------------------------------------------------------

describe("isMeaningfulAction", () => {
  it("returns true for interactive actions", () => {
    expect(isMeaningfulAction(makeEvent("click", 0))).toBe(true);
    expect(isMeaningfulAction(makeEvent("type", 0))).toBe(true);
    expect(isMeaningfulAction(makeEvent("scroll", 0))).toBe(true);
    expect(isMeaningfulAction(makeEvent("navigate", 0))).toBe(true);
    expect(isMeaningfulAction(makeEvent("drag", 0))).toBe(true);
  });

  it("returns false for non-interactive events", () => {
    expect(isMeaningfulAction(makeEvent("idle", 0))).toBe(false);
    expect(isMeaningfulAction(makeEvent("screenshot", 0))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createPlaybackPlan
// ---------------------------------------------------------------------------

describe("createPlaybackPlan", () => {
  it("returns single 1x segment when no events", () => {
    const plan = createPlaybackPlan([], 10000);
    expect(plan.segments).toHaveLength(1);
    expect(plan.segments[0].playbackRate).toBe(1);
    expect(plan.segments[0].sourceDurationMs).toBe(10000);
    expect(plan.outputDurationMs).toBe(10000);
    expect(plan.trimStartMs).toBe(0);
  });

  it("creates action window with padding for single event", () => {
    const plan = createPlaybackPlan([makeEvent("click", 5000)], 10000);

    // Should have: gap before, action window, gap after
    expect(plan.segments.length).toBeGreaterThanOrEqual(2);

    // Action window should contain t=5000 with padding
    const actionSeg = plan.segments.find((s) => s.type === "action");
    expect(actionSeg).toBeDefined();
    expect(actionSeg!.sourceStartMs).toBe(5000 - DEFAULT_SPEED_RAMP_CONFIG.preActionPaddingMs);
    expect(actionSeg!.sourceEndMs).toBe(5000 + DEFAULT_SPEED_RAMP_CONFIG.postActionPaddingMs);
    expect(actionSeg!.playbackRate).toBe(1);
  });

  it("merges overlapping action windows for close events", () => {
    const plan = createPlaybackPlan([makeEvent("click", 5000), makeEvent("type", 5300)], 10000);

    const actionSegs = plan.segments.filter((s) => s.type === "action");
    // Two events 300ms apart with 600+400ms padding → should merge into 1 window
    expect(actionSegs).toHaveLength(1);
  });

  it("compresses long gaps between actions", () => {
    const plan = createPlaybackPlan([makeEvent("click", 2000), makeEvent("click", 12000)], 15000);

    const gapSegs = plan.segments.filter((s) => s.type === "gap" && s.playbackRate > 1);
    expect(gapSegs.length).toBeGreaterThan(0);

    // The 10s gap between actions should be compressed
    const middleGap = gapSegs.find((s) => s.sourceStartMs > 2000 && s.sourceEndMs < 12000);
    expect(middleGap).toBeDefined();
    expect(middleGap!.playbackRate).toBeGreaterThan(1);
    expect(middleGap!.outputDurationMs).toBeLessThan(middleGap!.sourceDurationMs);
  });

  it("keeps short gaps at 1x", () => {
    // Two events 500ms apart (gap = ~500ms after padding overlap, < 800ms threshold)
    const plan = createPlaybackPlan([makeEvent("click", 1000), makeEvent("click", 2500)], 5000);

    // All gaps should be at 1x (below minGapToSpeedUp)
    for (const gap of plan.segments.filter((s) => s.type === "gap")) {
      if (gap.sourceDurationMs <= DEFAULT_SPEED_RAMP_CONFIG.minGapToSpeedUp) {
        expect(gap.playbackRate).toBe(1);
      }
    }
  });

  it("caps very long gaps to maxPlaybackRate", () => {
    const plan = createPlaybackPlan([makeEvent("click", 1000), makeEvent("click", 61000)], 65000);

    const longGap = plan.segments.find((s) => s.type === "gap" && s.sourceDurationMs > 50000);
    expect(longGap).toBeDefined();
    // 60s gap: minRateForMaxWait = 60000/2000 = 30 (to keep under maxGapOutputMs)
    // This exceeds maxPlaybackRate (8), but minRateForMaxWait takes priority
    // Output = 60000/30 = 2000ms (respects maxGapOutputMs)
    expect(longGap!.outputDurationMs).toBeLessThanOrEqual(
      DEFAULT_SPEED_RAMP_CONFIG.maxGapOutputMs + 1
    );
    // But it should still be compressed (faster than 1x)
    expect(longGap!.outputDurationMs).toBeLessThan(longGap!.sourceDurationMs);
  });

  it("computes trimStartMs from first action", () => {
    const plan = createPlaybackPlan([makeEvent("click", 5000)], 10000);
    expect(plan.trimStartMs).toBe(5000 - DEFAULT_SPEED_RAMP_CONFIG.preActionPaddingMs);
  });

  it("sets trimStartMs to 0 when first action is near start", () => {
    const plan = createPlaybackPlan([makeEvent("click", 200)], 10000);
    expect(plan.trimStartMs).toBe(0);
  });

  it("segments are contiguous in output time", () => {
    const plan = createPlaybackPlan(
      [
        makeEvent("click", 3000),
        makeEvent("type", 8000),
        makeEvent("scroll", 15000),
        makeEvent("click", 25000),
      ],
      30000
    );

    for (let i = 1; i < plan.segments.length; i++) {
      expect(plan.segments[i].outputStartMs).toBeCloseTo(plan.segments[i - 1].outputEndMs, 1);
    }
  });

  it("output is shorter than source for sessions with gaps", () => {
    const events = Array.from({ length: 22 }, (_, i) => makeEvent("click", 2000 + i * 2500));
    const plan = createPlaybackPlan(events, 57000);

    expect(plan.outputDurationMs).toBeLessThan(57000);
  });

  it("filters events beyond source duration (no negative segments)", () => {
    // Regression: events at 25s, 30s, 35s with 18.6s video caused negative
    // action durations and negative outputDurationMs (-8100ms)
    const events = [
      makeEvent("navigate", 5000),
      makeEvent("click", 8000),
      makeEvent("type", 12000),
      makeEvent("scroll", 15000),
      makeEvent("click", 25000), // Beyond 18.6s source
      makeEvent("navigate", 30000), // Beyond 18.6s source
      makeEvent("scroll", 35000), // Beyond 18.6s source
    ];

    const plan = createPlaybackPlan(events, 18600);

    // All durations must be positive
    expect(plan.outputDurationMs).toBeGreaterThan(0);
    for (const s of plan.segments) {
      expect(s.outputDurationMs).toBeGreaterThanOrEqual(0);
      expect(s.sourceDurationMs).toBeGreaterThanOrEqual(0);
      expect(s.sourceEndMs).toBeGreaterThanOrEqual(s.sourceStartMs);
      expect(s.outputEndMs).toBeGreaterThanOrEqual(s.outputStartMs);
    }

    // Events beyond source should be excluded
    const maxSourceEnd = Math.max(...plan.segments.map((s) => s.sourceEndMs));
    expect(maxSourceEnd).toBeLessThanOrEqual(18600);
  });

  it("ignores idle and screenshot events", () => {
    const plan = createPlaybackPlan(
      [makeEvent("idle", 1000), makeEvent("screenshot", 2000), makeEvent("click", 5000)],
      10000
    );

    // Only one action window (from the click)
    const actionSegs = plan.segments.filter((s) => s.type === "action");
    expect(actionSegs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// sourceToOutputTime / outputToSourceTime
// ---------------------------------------------------------------------------

describe("time mapping", () => {
  it("round-trips through source→output→source", () => {
    const plan = createPlaybackPlan([makeEvent("click", 3000), makeEvent("click", 13000)], 20000);

    for (const sourceMs of [0, 3000, 5000, 10000, 13000, 18000]) {
      const outputMs = sourceToOutputTime(sourceMs, plan.segments);
      const backToSource = outputToSourceTime(outputMs, plan.segments);
      expect(backToSource).toBeCloseTo(sourceMs, 0);
    }
  });

  it("action segments map 1:1", () => {
    const plan = createPlaybackPlan([makeEvent("click", 5000)], 10000);
    const actionSeg = plan.segments.find((s) => s.type === "action")!;

    const mid = (actionSeg.sourceStartMs + actionSeg.sourceEndMs) / 2;
    const outputMid = sourceToOutputTime(mid, plan.segments);
    const expectedOutputMid = (actionSeg.outputStartMs + actionSeg.outputEndMs) / 2;
    expect(outputMid).toBeCloseTo(expectedOutputMid, 0);
  });

  it("gap segments compress time", () => {
    const plan = createPlaybackPlan([makeEvent("click", 1000), makeEvent("click", 11000)], 15000);

    const gapSeg = plan.segments.find((s) => s.type === "gap" && s.playbackRate > 1);
    if (gapSeg) {
      // Source midpoint should map to a closer output time
      const sourceMid = (gapSeg.sourceStartMs + gapSeg.sourceEndMs) / 2;
      const outputMid = sourceToOutputTime(sourceMid, plan.segments);
      const outputMidExpected = (gapSeg.outputStartMs + gapSeg.outputEndMs) / 2;
      expect(outputMid).toBeCloseTo(outputMidExpected, 0);
    }
  });
});
