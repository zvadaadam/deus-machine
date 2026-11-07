/**
 * Render a finalized bundle into a rendition. Never touches the original.
 *
 *   FFmpeg decode + retime (edit map) → JPEG frames → painter → FFmpeg encode
 *
 * Frames stream through one at a time, so memory stays flat for any length.
 * Everything that decides the picture is written to `renders/<name>.json`
 * first — run with `planOnly` to review it without rendering.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { BUNDLE_FILES, readEvents, readManifest } from "../bundle/bundle.js";
import type { Manifest } from "../bundle/schema.js";
import { cameraTrack } from "../direct/camera.js";
import { pointerTrack, touchTrack } from "../direct/cursor.js";
import {
  BACKGROUNDS,
  DEFAULT_PRESET,
  PRESETS,
  type BackgroundStyle,
  type CursorStyle,
  type FrameStyle,
  type Preset,
} from "../direct/presets.js";
import { planShots, type Shot } from "../direct/shots.js";
import {
  chaptersToFfmetadata,
  chaptersToWebVtt,
  mapChapters,
  type OutputChapter,
} from "../edit/chapters.js";
import type { EditSegment } from "../edit/edit-map.js";
import { analyzeMotion, measureChanges } from "../edit/motion.js";
import { findResults } from "../edit/results.js";
import { planPacing, type PacingMode } from "../edit/pacing.js";
import { buildTimeline, isUnseen, type TimelineAction } from "../edit/timeline.js";
import { ScreenStudioError } from "../errors.js";
import { extractFrame, ffmpegBin, probeMedia } from "../util/ffmpeg.js";
import { JpegSplitter } from "../util/jpeg.js";
import { tail } from "../util/process.js";
import { even, type Size } from "../util/units.js";
import { computeLayout, resolveFrame, type Layout } from "./layout.js";
import { FramePainter, loadCanvas } from "./painter.js";

export interface RenderOptions {
  /** review | walkthrough | demo. Default: walkthrough. */
  preset?: string;
  pacing?: PacingMode;
  /** Desired output length. Reported as unmet rather than cutting actions. */
  targetDurationMs?: number;
  /** Rendition name; files are renders/<name>.{mp4,json,vtt,jpg}. Default: the preset. */
  name?: string;
  /** Explicit output path for the video. */
  output?: string;
  size?: Size | "source";
  fps?: number;
  cursor?: CursorStyle | "auto";
  frame?: FrameStyle;
  /** A named background, "#hex", "#from,#to", or "none". */
  background?: string | BackgroundStyle | null;
  zoom?: boolean;
  maxZoom?: number;
  /** Text in the browser bar or window title. Default: the recorded page. */
  title?: string;
  /** Use motion analysis to tell still waits from animations. Default: true. */
  motion?: boolean;
  /** FFmpeg only: retime and frame, no pointer, zoom or chrome. */
  plain?: boolean;
  /** Write the plan and stop. */
  planOnly?: boolean;
  onProgress?: (progress: { frame: number; frames: number }) => void;
  signal?: AbortSignal;
}

export interface RenderedEvent {
  id: string;
  type: string;
  /** Output time of the action's start. */
  timeMs: number;
  sourceMs: number;
  label?: string;
  url?: string;
  text?: string;
}

export interface RenderPlan {
  format: "screen-studio/render-plan";
  version: 1;
  name: string;
  preset: string;
  bundleId: string;
  mediaSha256: string;
  output: { path: string; size: Size; fps: number; frames: number; durationMs: number };
  pacing: {
    mode: PacingMode;
    level: string;
    targetDurationMs?: number;
    targetMet?: boolean;
    sourceDurationMs: number;
    keptMs: number;
    segments: readonly EditSegment[];
  };
  chapters: OutputChapter[];
  events: RenderedEvent[];
  camera: { enabled: boolean; maxZoom: number; shots: Shot[] };
  cursor: { style: string; provenance: string };
  layout: Layout;
  renderer: "canvas" | "ffmpeg";
  warnings: string[];
}

export interface RenderResult {
  name: string;
  outputPath: string;
  planPath: string;
  vttPath: string | null;
  posterPath: string | null;
  durationMs: number;
  frames: number;
  sourceDurationMs: number;
  chapters: OutputChapter[];
  events: RenderedEvent[];
  targetMet?: boolean;
  warnings: string[];
  plan: RenderPlan;
}

export function resolveBackground(
  value: RenderOptions["background"],
  fallback: BackgroundStyle | null
): BackgroundStyle | null {
  if (value === undefined) return fallback;
  if (value === null || value === "none") return null;
  if (typeof value !== "string") return value;
  if (BACKGROUNDS[value]) return BACKGROUNDS[value];
  const colors = value.split(",").map((c) => c.trim());
  if (colors.every((c) => /^#[0-9a-f]{3,8}$/i.test(c))) {
    return colors.length === 1
      ? { type: "solid", color: colors[0] }
      : { type: "gradient", from: colors[0], to: colors[1], angle: 135 };
  }
  throw new ScreenStudioError("invalid_argument", `Unknown background "${value}"`, {
    hint: `Use ${Object.keys(BACKGROUNDS).join(", ")}, none, "#hex" or "#from,#to"`,
  });
}

function titleFor(manifest: Manifest): string | undefined {
  const url = manifest.source.details.url;
  if (typeof url === "string" && /^https?:/.test(url)) {
    try {
      const parsed = new URL(url);
      return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
    } catch {
      return url;
    }
  }
  return manifest.source.label;
}

export async function renderBundle(
  dir: string,
  options: RenderOptions = {}
): Promise<RenderResult> {
  const root = resolve(dir);
  const manifest = await readManifest(root);
  if (manifest.status !== "complete" || !manifest.media) {
    throw new ScreenStudioError(
      "bundle_invalid",
      `Recording is ${manifest.status}; only finalized recordings render`,
      {
        hint:
          manifest.status === "recording"
            ? "Stop it first: screen-studio stop <dir>"
            : manifest.capture.error?.message,
      }
    );
  }
  const presetName = options.preset ?? DEFAULT_PRESET;
  const base: Preset | undefined = PRESETS[presetName];
  if (!base) {
    throw new ScreenStudioError("invalid_argument", `Unknown preset "${presetName}"`, {
      hint: `Presets: ${Object.keys(PRESETS).join(", ")}`,
    });
  }
  const name = options.name ?? presetName;
  if (!/^[\w.-]+$/.test(name))
    throw new ScreenStudioError("invalid_argument", `Invalid render name "${name}"`);
  const fps = options.fps ?? base.fps;
  const mediaPath = join(root, manifest.media.path);
  const mediaSize = { width: manifest.media.width, height: manifest.media.height };
  const { events, skipped } = await readEvents(root);
  const timeline = buildTimeline(manifest, events);
  const warnings = [...manifest.capture.warnings, ...timeline.warnings];
  if (skipped) warnings.push(`${skipped} malformed event lines were ignored.`);

  // Pacing
  const mode = options.pacing ?? base.pacing;
  let motion = null;
  if (mode !== "preserve" && options.motion !== false) {
    try {
      motion = await analyzeMotion(mediaPath, {
        sha256: manifest.media.sha256,
        durationMs: manifest.media.durationMs,
        cacheDir: join(root, BUNDLE_FILES.analysis),
      });
    } catch (err) {
      warnings.push(
        `Motion analysis unavailable (${(err as Error).message}); treating waits as still.`
      );
    }
  }
  const pacing = planPacing(timeline, { mode, targetDurationMs: options.targetDurationMs, motion });
  warnings.push(...pacing.warnings);
  const map = pacing.map;
  const durationMs = map.outputDurationMs;
  const frames = Math.max(1, Math.round((durationMs * fps) / 1000));

  // An edit cuts what was never painted, so nothing in it points there.
  const shown = (ms: number) => mode === "preserve" || !isUnseen(timeline, ms);
  const sourceActions = timeline.actions.filter((a) => shown(a.startMs));

  // Everything downstream lives in output time.
  const toOut = (ms: number) => map.toOutput(ms).ms;
  const actions: TimelineAction[] = sourceActions.map((a) => ({
    ...a,
    startMs: toOut(a.startMs),
    endMs: toOut(a.endMs),
  }));
  const focus = timeline.focus
    .filter((f) => shown(f.atMs))
    .map((f) => ({
      id: f.id,
      atMs: toOut(f.atMs),
      durationMs: f.durationMs,
      rect: f.rect,
      label: f.label,
    }));
  const { chapters, warnings: chapterWarnings } = mapChapters(timeline.chapters, map);
  warnings.push(...chapterWarnings);

  // Look
  const canvasAvailable = !options.plain && (await loadCanvas()) !== null;
  if (!options.plain && !canvasAvailable)
    warnings.push("@napi-rs/canvas is unavailable: rendered without pointer, zoom or chrome.");
  const background = resolveBackground(options.background, base.background);
  const output = outputSize(options.size ?? base.output, mediaSize, options.size !== undefined);
  const frameStyle = canvasAvailable
    ? resolveFrame(options.frame ?? base.frame, manifest.source.kind, background !== null)
    : "none";
  const layout = computeLayout(output, mediaSize, frameStyle);
  const camera = {
    ...base.camera,
    ...(options.zoom !== undefined ? { enabled: options.zoom } : {}),
    ...(options.maxZoom !== undefined ? { maxZoom: options.maxZoom } : {}),
  };
  if (!canvasAvailable) camera.enabled = false;
  // A phone screen is already narrow: zooming into it crops the UI sideways.
  // Touch indicators carry the actions instead, unless zoom is asked for.
  if (frameStyle === "device" && options.zoom === undefined && options.maxZoom === undefined)
    camera.enabled = false;

  // Results only steer the camera, so where each one appeared is measured
  // only when there is a camera to steer.
  let results = findResults(timeline, motion).filter((r) => shown(r.atMs));
  if (camera.enabled && results.length) {
    const measured = await measureChanges(
      mediaPath,
      results.map((r) => r.atMs),
      {
        sha256: manifest.media.sha256,
        size: mediaSize,
        cacheDir: join(root, BUNDLE_FILES.analysis),
      }
    ).catch(() => null);
    results = results.map((r) => ({ ...r, ...measured?.get(r.atMs) }));
  }
  const shotPlan = planShots({
    actions,
    focus,
    results: results.map((r) => ({ ...r, atMs: toOut(r.atMs) })),
    size: mediaSize,
    durationMs,
    tokens: camera,
  });
  warnings.push(...shotPlan.warnings);

  const requestedCursor = options.cursor ?? base.cursor.style;
  const cursorStyle: CursorStyle = !canvasAvailable
    ? "none"
    : requestedCursor !== "auto"
      ? requestedCursor
      : manifest.media.pointerInPixels === "system-cursor" ||
          manifest.media.pointerInPixels === "touches"
        ? "none"
        : manifest.source.kind === "ios-simulator"
          ? "touch"
          : "cua";

  const rendersDir = join(root, BUNDLE_FILES.renders);
  await mkdir(rendersDir, { recursive: true });
  const outputPath = options.output ? resolve(options.output) : join(rendersDir, `${name}.mp4`);
  if (outputPath === mediaPath) {
    throw new ScreenStudioError("invalid_argument", "A render cannot replace the original media", {
      hint: "Choose another output path.",
    });
  }
  const planPath = join(rendersDir, `${name}.json`);
  const vttPath = chapters.length ? join(rendersDir, `${name}.vtt`) : null;

  const plan: RenderPlan = {
    format: "screen-studio/render-plan",
    version: 1,
    name,
    preset: presetName,
    bundleId: manifest.id,
    mediaSha256: manifest.media.sha256,
    output: { path: relative(root, outputPath), size: output, fps, frames, durationMs },
    pacing: {
      mode,
      level: pacing.level,
      ...(pacing.targetDurationMs !== undefined
        ? { targetDurationMs: pacing.targetDurationMs, targetMet: pacing.targetMet }
        : {}),
      sourceDurationMs: timeline.durationMs,
      keptMs: Math.round(pacing.keptMs),
      segments: map.segments,
    },
    chapters,
    events: sourceActions.map((a, i) => ({
      id: a.id,
      type: a.type,
      timeMs: Math.round(actions[i].startMs),
      sourceMs: Math.round(a.startMs),
      ...(a.label ? { label: a.label } : {}),
      ...(a.url ? { url: a.url } : {}),
      ...(a.text ? { text: a.text } : {}),
    })),
    camera: { enabled: camera.enabled, maxZoom: camera.maxZoom, shots: shotPlan.shots },
    cursor: {
      style: cursorStyle,
      provenance:
        cursorStyle === "none"
          ? "no overlay"
          : "generated between recorded action targets; not an observed pointer path",
    },
    layout,
    renderer: canvasAvailable ? "canvas" : "ffmpeg",
    warnings,
  };
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  if (vttPath) await writeFile(vttPath, chaptersToWebVtt(chapters));
  const result = (posterPath: string | null, renderedFrames: number): RenderResult => ({
    name,
    outputPath,
    planPath,
    vttPath,
    posterPath,
    durationMs,
    frames: renderedFrames,
    sourceDurationMs: timeline.durationMs,
    chapters,
    events: plan.events,
    ...(pacing.targetMet !== undefined ? { targetMet: pacing.targetMet } : {}),
    warnings,
    plan,
  });
  if (options.planOnly) return result(null, 0);

  const metaPath = join(rendersDir, `.${name}.ffmeta`);
  await writeFile(metaPath, chaptersToFfmetadata(chapters, options.title ?? titleFor(manifest)));
  const tmpPath = `${outputPath}.part.mp4`;
  const encodeArgs = [
    "-map_metadata",
    "1",
    "-map_chapters",
    "1",
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-y",
    tmpPath,
  ];

  let rendered = 0;
  try {
    if (canvasAvailable) {
      rendered = await renderWithCanvas({
        mediaPath,
        metaPath,
        encodeArgs,
        filter: (prefilter) =>
          map.ffmpegFilter({ fps, mediaDurationMs: manifest.media!.durationMs, prefilter }),
        frames,
        fps,
        layout,
        mediaSize,
        background,
        title: options.title ?? titleFor(manifest),
        cursorStyle,
        cursorTokens: base.cursor,
        cameraTrack: cameraTrack(shotPlan.shots, frames, fps, mediaSize, camera),
        pointer:
          cursorStyle === "cua" || cursorStyle === "arrow"
            ? pointerTrack(actions, frames, fps, mediaSize, base.cursor)
            : null,
        touch: cursorStyle === "touch" ? touchTrack(actions, frames, fps, base.cursor) : null,
        maxZoom: camera.enabled ? camera.maxZoom : 1,
        onProgress: options.onProgress,
        signal: options.signal,
      });
    } else {
      const color =
        background?.type === "solid"
          ? background.color
          : background?.type === "gradient"
            ? background.to
            : "#000000";
      const fit = `scale=${output.width}:${output.height}:force_original_aspect_ratio=decrease,pad=${output.width}:${output.height}:(ow-iw)/2:(oh-ih)/2:color=${color.replace("#", "0x")}`;
      await runFfmpeg(
        [
          "-v",
          "error",
          "-i",
          mediaPath,
          "-i",
          metaPath,
          "-filter_complex",
          map.ffmpegFilter({ fps, mediaDurationMs: manifest.media.durationMs, postfilter: fit }),
          "-map",
          "[out]",
          "-frames:v",
          String(frames),
          ...encodeArgs,
        ],
        options.signal
      );
      rendered = frames;
    }
    await rename(tmpPath, outputPath);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  } finally {
    await unlink(metaPath).catch(() => {});
  }

  const probe = await probeMedia(outputPath);
  if (Math.abs(probe.durationMs - durationMs) > Math.max(200, 3000 / fps)) {
    warnings.push(
      `Rendered ${probe.durationMs} ms; the plan expected ${Math.round(durationMs)} ms.`
    );
  }
  const posterPath = join(rendersDir, `${name}.jpg`);
  const posterAt = chapters[0] ? chapters[0].startMs + 600 : Math.min(1000, durationMs / 3);
  const poster = await extractFrame(
    outputPath,
    Math.min(posterAt, Math.max(0, durationMs - 100)),
    posterPath,
    960
  )
    .then(() => posterPath)
    .catch(() => null);
  plan.output.frames = rendered;
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  return result(poster, rendered);
}

/** Sharing sizes stay within this long edge, whatever the source. */
const MAX_SOURCE_EDGE = 1920;

/**
 * The output size. `source` keeps the source's shape within a sharing size.
 * A preset's landscape canvas turns portrait for a portrait source — a phone
 * on a wide canvas is a third of the picture — unless the size was asked for.
 */
export function outputSize(size: Size | "source", media: Size, explicit: boolean): Size {
  if (size === "source") {
    const scale = Math.min(1, MAX_SOURCE_EDGE / Math.max(media.width, media.height));
    return { width: even(media.width * scale), height: even(media.height * scale) };
  }
  const portraitSource = media.height > media.width * 1.2;
  if (!explicit && portraitSource && size.width > size.height) {
    return { width: even(size.height), height: even(size.width) };
  }
  return { width: even(size.width), height: even(size.height) };
}

interface CanvasRenderJob {
  mediaPath: string;
  metaPath: string;
  encodeArgs: string[];
  filter: (prefilter?: string) => string;
  frames: number;
  fps: number;
  layout: Layout;
  mediaSize: Size;
  background: BackgroundStyle | null;
  title?: string;
  cursorStyle: CursorStyle;
  cursorTokens: Preset["cursor"];
  cameraTrack: ReturnType<typeof cameraTrack>;
  pointer: ReturnType<typeof pointerTrack> | null;
  touch: ReturnType<typeof touchTrack> | null;
  maxZoom: number;
  onProgress?: RenderOptions["onProgress"];
  signal?: AbortSignal;
}

async function renderWithCanvas(job: CanvasRenderJob): Promise<number> {
  // Decode no larger than the deepest zoom can show.
  const { content } = job.layout;
  const needed = Math.max(
    (content.width * job.maxZoom) / job.mediaSize.width,
    (content.height * job.maxZoom) / job.mediaSize.height
  );
  const scale = Math.min(1, needed * 1.05);
  const frameSize =
    scale < 0.98
      ? { width: even(job.mediaSize.width * scale), height: even(job.mediaSize.height * scale) }
      : job.mediaSize;
  const prefilter =
    frameSize === job.mediaSize
      ? undefined
      : `scale=${frameSize.width}:${frameSize.height}:flags=lanczos`;

  const painter = await FramePainter.create({
    layout: job.layout,
    frameSize,
    mediaSize: job.mediaSize,
    background: job.background,
    title: job.title,
    cursor: job.cursorStyle,
    pointerSize: job.cursorTokens.size * job.layout.output.height,
    rippleMs: job.cursorTokens.rippleMs,
  });

  const decoder = spawnFfmpeg([
    "-v",
    "error",
    "-i",
    job.mediaPath,
    "-filter_complex",
    job.filter(prefilter),
    "-map",
    "[out]",
    "-frames:v",
    String(job.frames),
    "-f",
    "image2pipe",
    "-c:v",
    "mjpeg",
    "-q:v",
    "2",
    "pipe:1",
  ]);
  const encoder = spawnFfmpeg(
    [
      "-v",
      "error",
      "-f",
      "image2pipe",
      "-framerate",
      String(job.fps),
      "-c:v",
      "mjpeg",
      "-i",
      "pipe:0",
      "-i",
      job.metaPath,
      "-map",
      "0:v",
      ...job.encodeArgs,
    ],
    "pipe"
  );
  const abort = () => {
    decoder.child.kill("SIGKILL");
    encoder.child.kill("SIGKILL");
  };
  job.signal?.addEventListener("abort", abort, { once: true });

  const splitter = new JpegSplitter();
  let index = 0;
  let written = 0;
  const stdin = encoder.child.stdin!;
  stdin.on("error", () => {});
  // Two frames in flight: one paints while the previous compresses.
  const inFlight: Array<Promise<Buffer>> = [];
  const flush = async (keep: number) => {
    while (inFlight.length > keep) {
      const frame = await inFlight.shift()!;
      if (!stdin.write(frame)) {
        await Promise.race([new Promise((r) => stdin.once("drain", r)), encoder.exited]);
      }
      written++;
      if (written % 30 === 0) job.onProgress?.({ frame: written, frames: job.frames });
    }
  };
  try {
    for await (const chunk of decoder.child.stdout!) {
      for (const jpeg of splitter.push(chunk as Buffer)) {
        if (index >= job.frames) break;
        const camera = job.cameraTrack[index] ?? job.cameraTrack.at(-1)!;
        inFlight.push(
          painter.render(jpeg, camera, job.pointer?.[index] ?? null, job.touch?.[index] ?? null)
        );
        index++;
        await flush(1);
      }
    }
    await flush(0);
    stdin.end();
    const [decoded, encoded] = await Promise.all([decoder.exited, encoder.exited]);
    if (job.signal?.aborted) throw new ScreenStudioError("aborted", "Render cancelled");
    if (decoded.code !== 0)
      throw new ScreenStudioError("render_failed", `Decoding failed: ${tail(decoded.stderr)}`);
    if (encoded.code !== 0)
      throw new ScreenStudioError("render_failed", `Encoding failed: ${tail(encoded.stderr)}`);
    if (index === 0) throw new ScreenStudioError("render_failed", "The edit produced no frames");
  } catch (err) {
    abort();
    throw err;
  } finally {
    job.signal?.removeEventListener("abort", abort);
  }
  job.onProgress?.({ frame: written, frames: job.frames });
  return written;
}

function spawnFfmpeg(args: string[], stdin: "pipe" | "ignore" = "ignore") {
  const child: ChildProcess = spawn(ffmpegBin(), args, { stdio: [stdin, "pipe", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });
  const exited = new Promise<{ code: number | null; stderr: string }>((resolve) => {
    child.once("close", (code) => resolve({ code, stderr }));
    child.once("error", (err) => resolve({ code: -1, stderr: err.message }));
  });
  return { child, exited };
}

async function runFfmpeg(args: string[], signal?: AbortSignal): Promise<void> {
  const { child, exited } = spawnFfmpeg(args);
  const abort = () => child.kill("SIGKILL");
  signal?.addEventListener("abort", abort, { once: true });
  const { code, stderr } = await exited;
  signal?.removeEventListener("abort", abort);
  if (signal?.aborted) throw new ScreenStudioError("aborted", "Render cancelled");
  if (code !== 0) throw new ScreenStudioError("render_failed", `FFmpeg failed: ${tail(stderr)}`);
}
