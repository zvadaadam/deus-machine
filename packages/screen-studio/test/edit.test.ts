import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { chaptersToFfmetadata, chaptersToWebVtt, mapChapters } from "../src/edit/chapters.js";
import { EditMap } from "../src/edit/edit-map.js";
import { planPacing } from "../src/edit/pacing.js";
import { buildTimeline, isUnseen } from "../src/edit/timeline.js";
import type { MotionAnalysis } from "../src/edit/motion.js";
import { action, at, chapter, manifest } from "./helpers.js";

const still = (ranges: Array<[number, number]>): MotionAnalysis => ({
  method: "ffmpeg-freezedetect",
  mediaSha256: "x",
  width: 256,
  noise: "-50dB",
  minStillMs: 400,
  revision: 3,
  stillRanges: ranges.map(([startMs, endMs]) => ({ startMs, endMs })),
  changes: [],
});

const unseen = (fromMs: number, toMs: number) => ({
  kind: "unseen" as const,
  id: `u${fromMs}`,
  at: at(fromMs),
  endAt: at(toMs),
  reason: "the page was not painted",
});

describe("timeline", () => {
  it("shifts events onto media time and scales their coordinate space", () => {
    const m = manifest({
      geometry: { viewport: { width: 640, height: 400 }, media: { width: 1280, height: 800 } },
    });
    const t = buildTimeline(m, [
      action(1000, { rect: { x: 10, y: 20, width: 30, height: 40 } }),
      action(2000, {
        point: { x: 100, y: 50 },
        space: { width: 200, height: 100 },
        rect: undefined,
      }),
    ]);
    expect(t.actions[0]).toMatchObject({
      startMs: 1000,
      rect: { x: 20, y: 40, width: 60, height: 80 },
    });
    expect(t.actions[1].point).toEqual({ x: 640, y: 400 });
  });

  it("follows viewport changes recorded mid-capture", () => {
    const t = buildTimeline(manifest(), [
      { kind: "geometry", id: "g", at: at(500), viewport: { width: 640, height: 400 } },
      action(1000, { point: { x: 320, y: 200 }, rect: undefined }),
    ]);
    expect(t.actions[0].point).toEqual({ x: 640, y: 400 });
  });

  it("letterboxes a resized viewport instead of stretching it", () => {
    const t = buildTimeline(manifest(), [
      { kind: "geometry", id: "g", at: at(500), viewport: { width: 1000, height: 800 } },
      action(1000, { point: { x: 0, y: 400 }, rect: undefined }),
    ]);
    expect(t.actions[0].point).toEqual({ x: 140, y: 400 });
  });

  it("records where the source was not painted, and the actions it hid", () => {
    const t = buildTimeline(manifest(), [unseen(4000, 9000), action(6000), action(12_000)]);
    expect(t.unseen).toEqual([{ startMs: 4000, endMs: 9000, reason: "the page was not painted" }]);
    expect(isUnseen(t, 6000)).toBe(true);
    expect(isUnseen(t, 12_000)).toBe(false);
    expect(t.warnings.join(" ")).toMatch(/not painted for 5\.0 s.*1 action that happened there/);
  });

  it("drops events outside the recorded coverage with a warning", () => {
    const t = buildTimeline(manifest({}, 5000), [
      action(-5000),
      chapter(9000, "Late"),
      action(1000),
    ]);
    expect(t.actions).toHaveLength(1);
    expect(t.chapters).toHaveLength(0);
    expect(t.warnings).toHaveLength(2);
  });
});

describe("edit map", () => {
  const map = EditMap.fromSpans(
    [
      { sourceStartMs: 0, sourceEndMs: 2000, rate: 1, reason: "keep" },
      { sourceStartMs: 2000, sourceEndMs: 6000, rate: 4, reason: "fast" },
      { sourceStartMs: 6000, sourceEndMs: 16000, rate: null, reason: "cut" },
      { sourceStartMs: 16000, sourceEndMs: 18000, rate: 1, reason: "keep" },
    ],
    18000
  );

  it("maps both ways through speed-ups and cuts", () => {
    expect(map.outputDurationMs).toBe(5000);
    expect(map.toOutput(1000)).toEqual({ ms: 1000, cut: false });
    expect(map.toOutput(4000)).toEqual({ ms: 2500, cut: false });
    expect(map.toOutput(10_000)).toEqual({ ms: 3000, cut: true });
    expect(map.toOutput(17_000)).toEqual({ ms: 4000, cut: false });
    expect(map.toSource(2500)).toBe(4000);
    expect(map.toSource(4000)).toBe(17000);
  });

  it("merges adjacent spans with the same rate", () => {
    const merged = EditMap.fromSpans(
      [
        { sourceStartMs: 0, sourceEndMs: 1000, rate: 1, reason: "a" },
        { sourceStartMs: 1000, sourceEndMs: 2000, rate: 1, reason: "b" },
      ],
      2000
    );
    expect(merged.segments).toHaveLength(1);
    expect(merged.isIdentity).toBe(true);
  });

  it("produces exactly the planned frames through many speed changes", () => {
    const spans = Array.from({ length: 20 }, (_, i) => ({
      sourceStartMs: i * 500,
      sourceEndMs: (i + 1) * 500,
      rate: i % 2 ? 6 : 1,
      reason: "alternate",
    }));
    const alternating = EditMap.fromSpans(spans, 10_000);
    const filter = alternating.ffmpegFilter({ fps: 30, mediaDurationMs: 10_000 });
    const out = execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=64x48:rate=30:duration=10",
        "-filter_complex",
        filter,
        "-map",
        "[out]",
        "-f",
        "framemd5",
        "-",
      ],
      { encoding: "utf8" }
    );
    const frames = out.split("\n").filter((l) => l && !l.startsWith("#")).length;
    expect(frames).toBe(Math.round((alternating.outputDurationMs * 30) / 1000));
  });

  it("emits one trim per shown segment and pads sparse media", () => {
    const filter = map.ffmpegFilter({ fps: 30, mediaDurationMs: 15_000 });
    expect(filter).toContain("split=3");
    expect(filter.match(/trim=/g)).toHaveLength(3);
    expect(filter).toContain("tpad=stop_mode=clone:stop_duration=3.250");
    expect(filter).toContain("concat=n=3");
    expect(filter.endsWith("[out]")).toBe(true);
  });
});

describe("pacing", () => {
  it("preserve keeps original timing", () => {
    const plan = planPacing(buildTimeline(manifest(), [action(1000)]), { mode: "preserve" });
    expect(plan.map.isIdentity).toBe(true);
  });

  it("keeps actions and their results at 1x and speeds up still waits", () => {
    const t = buildTimeline(manifest({}, 12_000), [
      action(1000, { endAt: at(1100) }),
      action(9000),
    ]);
    const plan = planPacing(t, { mode: "compress", motion: still([[0, 12_000]]) });
    const kept = plan.map.segments.filter((s) => s.kind === "keep");
    expect(kept[0].sourceStartMs).toBeLessThanOrEqual(300);
    expect(kept[0].sourceEndMs).toBeGreaterThanOrEqual(1100 + 1200);
    const gap = plan.map.segments.find(
      (s) => s.sourceStartMs >= kept[0].sourceEndMs && s.kind === "speed"
    )!;
    expect(gap.rate).toBe(6);
    expect(plan.map.outputDurationMs).toBeLessThan(12_000);
  });

  it("never exceeds the rate cap and cuts the middle of waits over budget", () => {
    const t = buildTimeline(manifest({}, 60_000), [action(1000), action(50_000)]);
    const plan = planPacing(t, { mode: "compress", motion: still([[0, 60_000]]) });
    for (const s of plan.map.segments) if (s.rate !== null) expect(s.rate).toBeLessThanOrEqual(6);
    const cut = plan.map.segments.find(
      (s) => s.kind === "cut" && s.sourceStartMs > 2000 && s.sourceEndMs < 50_000
    );
    expect(cut).toBeDefined();
    // The interior gap costs at most its budget of output time.
    const interior = plan.map.segments.filter(
      (s) => s.sourceStartMs >= 2200 && s.sourceEndMs <= 49_300
    );
    const spent = interior.reduce((sum, s) => sum + (s.outputEndMs - s.outputStartMs), 0);
    expect(spent).toBeLessThanOrEqual(2001);
  });

  it("speeds moving footage less than still footage", () => {
    const t = buildTimeline(manifest({}, 10_000), [action(500), action(9500)]);
    const plan = planPacing(t, { mode: "compress", motion: still([[6000, 8000]]) });
    const rates = plan.map.segments.filter((s) => s.kind === "speed").map((s) => s.rate);
    expect(rates).toContain(2);
    expect(rates).toContain(6);
  });

  it("trims a long lead-in down to what precedes the first action", () => {
    const t = buildTimeline(manifest({}, 30_000), [action(20_000)]);
    const plan = planPacing(t, { mode: "cut", motion: still([[0, 30_000]]) });
    expect(plan.map.segments[0].kind).toBe("cut");
    expect(plan.map.toOutput(20_000).ms).toBeLessThan(1000);
  });

  it("escalates to meet a target duration, and says so when it cannot", () => {
    const t = buildTimeline(manifest({}, 40_000), [action(1000), action(15_000), action(30_000)]);
    const met = planPacing(t, {
      mode: "compress",
      targetDurationMs: 9000,
      motion: still([[0, 40_000]]),
    });
    expect(met.targetMet).toBe(true);
    expect(met.map.outputDurationMs).toBeLessThanOrEqual(9000);
    const unmet = planPacing(t, {
      mode: "compress",
      targetDurationMs: 1000,
      motion: still([[0, 40_000]]),
    });
    expect(unmet.targetMet).toBe(false);
    expect(unmet.warnings.join(" ")).toMatch(/not reachable/);
  });

  it("cuts what was never painted, even around an action", () => {
    const events = [action(2000), unseen(4000, 9000), action(6000), action(12_000)];
    const t = buildTimeline(manifest(), events);
    const { map } = planPacing(t, { mode: "compress", motion: still([]) });
    const hole = map.segments.find((s) => s.reason.includes("not painted"))!;
    expect(hole.rate).toBeNull();
    expect(hole.sourceStartMs).toBeLessThanOrEqual(4000);
    expect(hole.sourceEndMs).toBeGreaterThanOrEqual(9000);
    // Nothing from inside the hole reaches the output.
    for (const ms of [4100, 6000, 8900]) expect(map.toOutput(ms).ms).toBe(map.toOutput(9000).ms);
    // Preserve is the exception: original timing, frozen frames and all.
    const preserved = planPacing(t, { mode: "preserve" });
    expect(preserved.map.outputDurationMs).toBe(20_000);
  });

  it("paces video-only recordings by motion alone", () => {
    const t = buildTimeline(manifest({}, 20_000), []);
    expect(planPacing(t, { mode: "compress" }).map.isIdentity).toBe(true);
    const plan = planPacing(t, { mode: "compress", motion: still([[3000, 17_000]]) });
    expect(plan.map.outputDurationMs).toBeLessThan(10_000);
  });
});

describe("chapters", () => {
  const map = EditMap.fromSpans(
    [
      { sourceStartMs: 0, sourceEndMs: 4000, rate: 1, reason: "keep" },
      { sourceStartMs: 4000, sourceEndMs: 10_000, rate: null, reason: "cut" },
      { sourceStartMs: 10_000, sourceEndMs: 14_000, rate: 1, reason: "keep" },
    ],
    14_000
  );

  it("moves with the picture and snaps out of cuts", () => {
    const { chapters } = mapChapters(
      [
        { id: "a", title: "Start", atMs: 500 },
        { id: "b", title: "Inside cut", atMs: 6000 },
        { id: "c", title: "After", atMs: 12_000 },
      ],
      map
    );
    expect(chapters.map((c) => [c.title, c.startMs, c.snapped])).toEqual([
      ["Start", 500, false],
      ["Inside cut", 4000, true],
      ["After", 6000, false],
    ]);
    expect(chapters.at(-1)!.endMs).toBe(8000);
  });

  it("merges chapters left without footage of their own", () => {
    const { chapters, warnings } = mapChapters(
      [
        { id: "a", title: "First", atMs: 5000 },
        { id: "b", title: "Second", atMs: 9000 },
      ],
      map
    );
    expect(chapters.map((c) => c.title)).toEqual(["Second"]);
    expect(warnings).toHaveLength(1);
  });

  it("writes WebVTT and escaped FFmpeg metadata", () => {
    const { chapters } = mapChapters([{ id: "a", title: "Sign in; then = done", atMs: 1000 }], map);
    expect(chaptersToWebVtt(chapters)).toContain("00:00:01.000 --> 00:00:08.000");
    expect(chaptersToFfmetadata(chapters)).toContain("title=Sign in\\; then \\= done");
  });
});
