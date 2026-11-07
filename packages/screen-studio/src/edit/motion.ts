import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Rect } from "../bundle/schema.js";
import { ffmpegBin } from "../util/ffmpeg.js";
import { run, tail } from "../util/process.js";
import type { Size } from "../util/units.js";

/**
 * Where the picture is still. Derived and replaceable: cached under
 * `analysis/` and keyed by the media hash and parameters.
 */
export interface MotionAnalysis {
  method: "ffmpeg-freezedetect";
  mediaSha256: string;
  /** Analysis width; small enough that a caret blink or spinner reads as still. */
  width: number;
  noise: string;
  minStillMs: number;
  revision: number;
  stillRanges: Array<{ startMs: number; endMs: number }>;
  /**
   * Moments the picture changed after being still. A result arriving after a
   * wait looks like this; where it changed is measured only for the changes
   * that turn out to answer an action (`measureChanges`).
   */
  changes: Array<{ atMs: number }>;
}

const PARAMS = { width: 256, noise: "-50dB", minStillMs: 400, revision: 3 };

export async function analyzeMotion(
  mediaPath: string,
  options: { sha256: string; durationMs: number; cacheDir?: string }
): Promise<MotionAnalysis> {
  const cachePath = options.cacheDir ? join(options.cacheDir, "motion.json") : null;
  if (cachePath) {
    try {
      const cached = JSON.parse(await readFile(cachePath, "utf8")) as MotionAnalysis;
      if (
        cached.mediaSha256 === options.sha256 &&
        cached.width === PARAMS.width &&
        cached.noise === PARAMS.noise &&
        cached.minStillMs === PARAMS.minStillMs &&
        cached.revision === PARAMS.revision
      ) {
        return cached;
      }
    } catch {
      // no usable cache
    }
  }
  const result = await run(
    ffmpegBin(),
    [
      "-hide_banner",
      "-nostats",
      "-loglevel",
      "info",
      "-i",
      mediaPath,
      "-an",
      "-vf",
      `scale=${PARAMS.width}:-2,freezedetect=n=${PARAMS.noise}:d=${PARAMS.minStillMs / 1000}`,
      "-f",
      "null",
      "-",
    ],
    { timeoutMs: 300_000 }
  );
  if (result.code !== 0) throw new Error(`Motion analysis failed: ${tail(result.stderr)}`);
  const stillRanges = parseFreezes(result.stderr, options.durationMs);
  const changes = stillRanges
    .filter((range) => range.endMs < options.durationMs - 100)
    .map((range) => ({ atMs: range.endMs }));
  const analysis: MotionAnalysis = {
    method: "ffmpeg-freezedetect",
    mediaSha256: options.sha256,
    ...PARAMS,
    stillRanges,
    changes,
  };
  if (cachePath && options.cacheDir) {
    await mkdir(options.cacheDir, { recursive: true });
    await writeFile(cachePath, `${JSON.stringify(analysis, null, 2)}\n`);
  }
  return analysis;
}

export function parseFreezes(
  stderr: string,
  durationMs: number
): Array<{ startMs: number; endMs: number }> {
  const ranges: Array<{ startMs: number; endMs: number }> = [];
  let start: number | null = null;
  for (const line of stderr.split("\n")) {
    const begin = /freeze_start:\s*([\d.]+)/.exec(line);
    if (begin) {
      start = Number(begin[1]) * 1000;
      continue;
    }
    const end = /freeze_end:\s*([\d.]+)/.exec(line);
    if (end && start !== null) {
      ranges.push({ startMs: Math.round(start), endMs: Math.round(Number(end[1]) * 1000) });
      start = null;
    }
  }
  // A freeze that lasts to the end of the file has no freeze_end.
  if (start !== null) ranges.push({ startMs: Math.round(start), endMs: Math.round(durationMs) });
  return ranges;
}

const TILE = 8;

/** Gray pixels of one frame at the analysis width. */
async function grayFrame(mediaPath: string, atMs: number, width: number): Promise<Buffer> {
  const result = await run(
    ffmpegBin(),
    [
      "-v",
      "error",
      "-ss",
      (Math.max(0, atMs) / 1000).toFixed(3),
      "-i",
      mediaPath,
      "-frames:v",
      "1",
      "-vf",
      `scale=${width}:-2,format=gray`,
      "-f",
      "rawvideo",
      "-",
    ],
    { timeoutMs: 20_000 }
  );
  if (result.code !== 0) throw new Error(tail(result.stderr));
  return result.stdoutBuffer;
}

/**
 * Where the picture changed around `atMs`: the bounding box of 8×8 tiles
 * (at the analysis width) whose pixels moved noticeably between a frame just
 * before and one shortly after. Tiny changes (a caret, a spinner) are ignored.
 */
export async function changedRegion(
  mediaPath: string,
  atMs: number,
  size: Size
): Promise<{ region: Rect | null; share: number }> {
  const width = PARAMS.width;
  const [before, after] = await Promise.all([
    grayFrame(mediaPath, atMs - 150, width),
    grayFrame(mediaPath, atMs + 500, width),
  ]);
  const height = Math.floor(before.length / width);
  if (height < TILE || after.length !== before.length) return { region: null, share: 0 };
  const cols = Math.floor(width / TILE);
  const rows = Math.floor(height / TILE);
  let x0 = cols,
    y0 = rows,
    x1 = -1,
    y1 = -1,
    changed = 0;
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      let moved = 0;
      for (let y = ty * TILE; y < (ty + 1) * TILE; y++) {
        for (let x = tx * TILE; x < (tx + 1) * TILE; x++) {
          if (Math.abs(before[y * width + x] - after[y * width + x]) > 24) moved++;
        }
      }
      if (moved < (TILE * TILE) / 5) continue;
      changed++;
      x0 = Math.min(x0, tx);
      y0 = Math.min(y0, ty);
      x1 = Math.max(x1, tx);
      y1 = Math.max(y1, ty);
    }
  }
  const share = changed / (cols * rows);
  if (changed === 0 || share < 0.004) return { region: null, share };
  const sx = size.width / width;
  const sy = size.height / height;
  return {
    region: {
      x: x0 * TILE * sx,
      y: y0 * TILE * sy,
      width: (x1 - x0 + 1) * TILE * sx,
      height: (y1 - y0 + 1) * TILE * sy,
    },
    share,
  };
}

/**
 * Where the picture changed at each of `times` (cached per media hash):
 * measured only for result candidates, so long recordings stay cheap.
 */
export async function measureChanges(
  mediaPath: string,
  times: number[],
  options: { sha256: string; size: Size; cacheDir?: string }
): Promise<Map<number, { region: Rect | null; share: number }>> {
  const cachePath = options.cacheDir ? join(options.cacheDir, "changes.json") : null;
  let cache: {
    mediaSha256: string;
    regions: Record<string, { region: Rect | null; share: number }>;
  } = {
    mediaSha256: options.sha256,
    regions: {},
  };
  if (cachePath) {
    try {
      const stored = JSON.parse(await readFile(cachePath, "utf8")) as typeof cache;
      if (stored.mediaSha256 === options.sha256) cache = stored;
    } catch {
      // nothing cached yet
    }
  }
  const out = new Map<number, { region: Rect | null; share: number }>();
  let added = false;
  for (const atMs of times) {
    const key = String(Math.round(atMs));
    if (!cache.regions[key]) {
      cache.regions[key] = await changedRegion(mediaPath, atMs, options.size).catch(() => ({
        region: null,
        share: 0,
      }));
      added = true;
    }
    out.set(atMs, cache.regions[key]);
  }
  if (added && cachePath && options.cacheDir) {
    await mkdir(options.cacheDir, { recursive: true });
    await writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`);
  }
  return out;
}
