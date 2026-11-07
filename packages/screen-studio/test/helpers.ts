import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUNDLE_FORMAT,
  BUNDLE_VERSION,
  type BundleEvent,
  type Manifest,
} from "../src/bundle/schema.js";

export function tempDir(prefix = "ss-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Real JPEG frames from FFmpeg's test source. */
export function jpegFrames(count: number, size = "64x48"): Buffer[] {
  const out = execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=${size}:rate=10`,
    "-frames:v",
    String(count),
    "-f",
    "image2pipe",
    "-c:v",
    "mjpeg",
    "-",
  ]);
  const frames: Buffer[] = [];
  let start = 0;
  for (let i = 2; i < out.length - 1; i++) {
    if (out[i] === 0xff && out[i + 1] === 0xd8 && i > start) {
      frames.push(out.subarray(start, i));
      start = i;
    }
  }
  frames.push(out.subarray(start));
  return frames;
}

/** A finalized manifest for pure planning tests. Media zero is epoch 1_000_000. */
export function manifest(overrides: Partial<Manifest> = {}, durationMs = 20_000): Manifest {
  const origin = 1_000_000;
  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    id: "rec_test",
    createdAt: new Date(0).toISOString(),
    status: "complete",
    source: { id: "test", kind: "browser", backend: "cdp-screencast", label: "Test", details: {} },
    capture: {
      fps: 30,
      maxDurationMs: 600_000,
      maxBytes: 1e9,
      requestedAt: origin - 100,
      startedAt: origin,
      stoppedAt: origin + durationMs,
      stopReason: "requested",
      warnings: [],
    },
    clock: { mediaStartEpochMs: origin, uncertaintyMs: 20, method: "test" },
    geometry: { viewport: { width: 1280, height: 800 }, media: { width: 1280, height: 800 } },
    media: {
      path: "media/screen.mp4",
      sha256: "x",
      bytes: 1,
      durationMs,
      width: 1280,
      height: 800,
      codec: "h264",
      frameRate: "30/1",
      audio: false,
      pointerInPixels: "none",
    },
    ...overrides,
  };
}

let counter = 0;
/** Event at `ms` media time (origin 1_000_000). */
export function at(ms: number): number {
  return 1_000_000 + ms;
}
export function action(
  ms: number,
  extra: Partial<Extract<BundleEvent, { kind: "action" }>> = {}
): BundleEvent {
  return {
    kind: "action",
    id: `a${++counter}`,
    at: at(ms),
    type: "click",
    rect: { x: 100, y: 100, width: 80, height: 30 },
    ...extra,
  } as BundleEvent;
}
export function chapter(ms: number, title: string): BundleEvent {
  return { kind: "chapter", id: `c${++counter}`, at: at(ms), title };
}
