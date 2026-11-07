import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PRESETS } from "../src/direct/presets.js";
import { planShots } from "../src/direct/shots.js";
import { analyzeMotion, measureChanges } from "../src/edit/motion.js";
import { findResults } from "../src/edit/results.js";
import { buildTimeline } from "../src/edit/timeline.js";
import { action, manifest, tempDir } from "./helpers.js";

describe("result detection", () => {
  it("finds when the picture changed after a still wait, and where on request", async () => {
    // 640x400 gray for 2 s, then a white 160x100 box appears at (400, 250).
    const work = tempDir();
    const video = join(work, "change.mp4");
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=#556677:size=640x400:rate=30:duration=4",
      "-vf",
      "drawbox=x=400:y=250:w=160:h=100:color=white:t=fill:enable='gte(t,2)'",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      video,
    ]);
    const motion = await analyzeMotion(video, { sha256: "x", durationMs: 4000 });
    expect(motion.changes).toHaveLength(1);
    const [change] = motion.changes;
    expect(Math.abs(change.atMs - 2000)).toBeLessThan(100);

    const cacheDir = join(work, "analysis");
    const measured = await measureChanges(video, [change.atMs], {
      sha256: "x",
      size: { width: 640, height: 400 },
      cacheDir,
    });
    const { region, share } = measured.get(change.atMs)!;
    expect(region!.x).toBeGreaterThan(380);
    expect(region!.x).toBeLessThan(410);
    expect(region!.x + region!.width).toBeGreaterThan(550);
    expect(region!.y + region!.height).toBeGreaterThan(340);
    expect(share).toBeLessThan(0.15);
    // Measured once per media: a missing file answers from the cache.
    expect(existsSync(join(cacheDir, "changes.json"))).toBe(true);
    const again = await measureChanges(join(work, "gone.mp4"), [change.atMs], {
      sha256: "x",
      size: { width: 640, height: 400 },
      cacheDir,
    });
    expect(again.get(change.atMs)).toEqual({ region, share });
  }, 60_000);

  it("links a change to the action it answers, within reason", () => {
    const timeline = buildTimeline(manifest({}, 40_000), [
      action(1000, { endAt: 1_000_000 + 1100 }),
      action(20_000),
    ]);
    const motion = {
      method: "ffmpeg-freezedetect" as const,
      mediaSha256: "x",
      width: 256,
      noise: "-50dB",
      minStillMs: 400,
      revision: 3,
      stillRanges: [],
      changes: [
        { atMs: 1200 }, // the action's own effect
        { atMs: 6100 }, // a result
        { atMs: 55_000 }, // too late to be an answer
      ],
    };
    expect(findResults(timeline, motion)).toEqual([
      { atMs: 6100, actionId: timeline.actions[0].id, delayMs: 5000 },
    ]);
  });

  it("frames a result unless a focus hint already covers it", () => {
    const size = { width: 1280, height: 800 };
    const base = {
      actions: [
        {
          id: "a",
          type: "click" as const,
          startMs: 500,
          endMs: 600,
          rect: { x: 50, y: 50, width: 80, height: 30 },
        },
      ],
      size,
      durationMs: 9000,
      tokens: PRESETS.walkthrough.camera,
    };
    const result = {
      atMs: 5000,
      actionId: "a",
      delayMs: 4400,
      region: { x: 900, y: 500, width: 300, height: 200 },
      share: 0.06,
    };
    const framed = planShots({ ...base, focus: [], results: [result] }).shots.find((s) =>
      s.reason.startsWith("result")
    );
    expect(framed?.target).toEqual(result.region);
    const hinted = planShots({
      ...base,
      focus: [
        { id: "f", atMs: 5200, durationMs: 2000, rect: { x: 0, y: 0, width: 200, height: 200 } },
      ],
      results: [result],
    });
    expect(hinted.shots.some((s) => s.reason.startsWith("result"))).toBe(false);
    const page = planShots({ ...base, focus: [], results: [{ ...result, share: 0.8 }] });
    // A new page: the camera is wide when it arrives (merged into an earlier wide shot).
    const active = [...page.shots].reverse().find((s) => s.atMs <= 5000)!;
    expect(active.camera.zoom).toBe(1);
  });
});
