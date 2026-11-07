import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { appendEvents, makeEvent } from "../src/bundle/bundle.js";
import type { Manifest } from "../src/bundle/schema.js";
import { importVideo } from "../src/import.js";
import { inspectBundle } from "../src/render/inspect.js";
import { outputSize, renderBundle } from "../src/render/render.js";
import { probeMedia, sha256File } from "../src/util/ffmpeg.js";
import { tempDir } from "./helpers.js";

/**
 * A 12 s "recording": a moving pattern for 2 s, then a still screen until a
 * change at 10 s. Actions at 1 s and 10.5 s; the still middle is a wait.
 */
let dir: string;
let video: string;
let manifest: Manifest;

beforeAll(async () => {
  const work = tempDir();
  video = join(work, "source.mp4");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=640x400:rate=30:duration=2",
    "-f",
    "lavfi",
    "-i",
    "color=c=#334455:size=640x400:rate=30:duration=8",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=640x400:rate=30:duration=2",
    "-filter_complex",
    "[0][1][2]concat=n=3:v=1:a=0",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    video,
  ]);
  dir = join(work, "bundle");
  manifest = await importVideo(video, dir, { kind: "browser" });
  await appendEvents(dir, [
    makeEvent({ kind: "chapter", at: 800, title: "Fill in" }),
    makeEvent({
      kind: "action",
      type: "click",
      at: 1000,
      endAt: 1100,
      rect: { x: 40, y: 40, width: 120, height: 40 },
    }),
    makeEvent({ kind: "chapter", at: 10_200, title: "Result" }),
    makeEvent({
      kind: "action",
      type: "click",
      at: 10_500,
      rect: { x: 400, y: 300, width: 100, height: 40 },
    }),
  ]);
}, 60_000);

describe("import", () => {
  it("wraps an existing video with measured facts", () => {
    expect(manifest.status).toBe("complete");
    expect(manifest.media).toMatchObject({ width: 640, height: 400, frames: 360 });
    expect(manifest.clock?.mediaStartEpochMs).toBe(0);
  });
});

describe("render", () => {
  it("plans without rendering", async () => {
    const result = await renderBundle(dir, { preset: "demo", planOnly: true });
    expect(existsSync(result.planPath)).toBe(true);
    expect(existsSync(result.outputPath)).toBe(false);
    expect(result.plan.pacing.segments.some((s) => s.kind === "cut")).toBe(true);
    expect(result.durationMs).toBeLessThan(8000);
  });

  it("renders a shorter, chaptered video and leaves the original untouched", async () => {
    const before = await sha256File(join(dir, manifest.media!.path));
    const result = await renderBundle(dir, {
      preset: "walkthrough",
      size: { width: 960, height: 540 },
    });
    const probe = await probeMedia(result.outputPath);
    expect(probe).toMatchObject({ width: 960, height: 540 });
    expect(Math.abs(probe.durationMs - result.durationMs)).toBeLessThan(150);
    expect(result.durationMs).toBeLessThan(11_000);
    const chapters = JSON.parse(
      execFileSync("ffprobe", ["-v", "error", "-show_chapters", "-of", "json", result.outputPath], {
        encoding: "utf8",
      })
    ).chapters as Array<{ tags: { title: string } }>;
    expect(chapters.map((c) => c.tags.title)).toEqual(["Fill in", "Result"]);
    expect(result.chapters[1].startMs).toBeLessThan(10_200);
    expect(result.posterPath && existsSync(result.posterPath)).toBe(true);
    expect(await sha256File(join(dir, manifest.media!.path))).toBe(before);
  }, 120_000);

  it("renders with FFmpeg alone when asked", async () => {
    const result = await renderBundle(dir, {
      preset: "demo",
      plain: true,
      name: "plain",
      size: { width: 640, height: 360 },
    });
    expect(result.plan.renderer).toBe("ffmpeg");
    const probe = await probeMedia(result.outputPath);
    expect(Math.abs(probe.durationMs - result.durationMs)).toBeLessThan(150);
  }, 120_000);

  it("replays without styling and leaves out what was never painted", async () => {
    const hidden = join(tempDir(), "bundle");
    await importVideo(video, hidden, { kind: "browser" });
    await appendEvents(hidden, [
      makeEvent({ kind: "action", type: "click", at: 1000, point: { x: 50, y: 50 } }),
      makeEvent({ kind: "unseen", at: 3000, endAt: 8000, reason: "the page was not painted" }),
      makeEvent({ kind: "action", type: "click", at: 5000, point: { x: 300, y: 200 } }),
      makeEvent({ kind: "action", type: "click", at: 10_500, point: { x: 450, y: 320 } }),
    ]);
    const result = await renderBundle(hidden, { preset: "replay", planOnly: true });
    expect(result.plan.output.size).toEqual({ width: 640, height: 400 });
    expect(result.plan.camera.enabled).toBe(false);
    expect(result.events.map((e) => e.sourceMs)).toEqual([1000, 10_500]);
    expect(result.durationMs).toBeLessThan(12_000 - 5000);
    expect(result.warnings.join(" ")).toMatch(/not painted for 5\.0 s/);
  });

  it("rejects unknown presets with the valid ones", async () => {
    await expect(renderBundle(dir, { preset: "cinematic" })).rejects.toMatchObject({
      code: "invalid_argument",
      hint: expect.stringContaining("walkthrough"),
    });
  });

  it("sizes the output for the source", () => {
    const wide = { width: 1920, height: 1080 };
    const phone = { width: 1206, height: 2622 };
    expect(outputSize(wide, phone, false)).toEqual({ width: 1080, height: 1920 });
    expect(outputSize(wide, phone, true)).toEqual(wide);
    expect(outputSize(wide, { width: 1280, height: 800 }, false)).toEqual(wide);
    expect(outputSize("source", { width: 3456, height: 2234 }, false)).toEqual({
      width: 1920,
      height: 1240,
    });
    expect(outputSize("source", { width: 641, height: 400 }, false)).toEqual({
      width: 640,
      height: 400,
    });
  });

  it("inspects with a contact sheet", async () => {
    const result = await inspectBundle(dir, { contactSheet: true });
    expect(result.events.byKind).toEqual({ chapter: 2, action: 2 });
    expect(result.renders.map((r) => r.name).sort()).toEqual(["demo", "plain", "walkthrough"]);
    expect(result.contactSheet && existsSync(result.contactSheet)).toBe(true);
  }, 60_000);
});
