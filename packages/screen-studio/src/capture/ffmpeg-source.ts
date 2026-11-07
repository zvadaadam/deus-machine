import { spawn } from "node:child_process";
import { join } from "node:path";
import { ScreenStudioError } from "../errors.js";
import { ffmpegBin } from "../util/ffmpeg.js";
import { run, tail } from "../util/process.js";
import type { Size } from "../util/units.js";
import type { ActiveCapture, CaptureBackend, CaptureContext } from "./backend.js";
import { finalizeFragmented } from "./cdp.js";

const READY_TIMEOUT_MS = 15_000;

/**
 * Run an FFmpeg input (avfoundation, lavfi) straight into a crash-safe
 * fragmented MP4. Media zero is derived from FFmpeg's own progress clock:
 * `now - out_time` at the first progress report.
 */
async function startFfmpegCapture(
  input: string[],
  context: CaptureContext,
  options: {
    classifyFailure?: (stderr: string) => ScreenStudioError | null;
    geometry?: { viewport: Size; media: Size };
  }
): Promise<ActiveCapture> {
  const partPath = join(context.mediaDir, "screen.part.mp4");
  const finalPath = join(context.mediaDir, "screen.mp4");
  const child = spawn(
    ffmpegBin(),
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostats",
      "-progress",
      "pipe:1",
      "-stats_period",
      "0.25",
      ...input,
      "-vf",
      "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      // No lookahead: output timestamps track capture, which the clock relies on.
      "-tune",
      "zerolatency",
      "-crf",
      "20",
      "-g",
      String(context.fps * 2),
      "-movflags",
      "+frag_keyframe+empty_moov+default_base_moof",
      "-f",
      "mp4",
      "-y",
      partPath,
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  let stderr = "";
  let stopping = false;
  let frames = 0;
  let mediaStart = 0;
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });
  const exited = new Promise<{ code: number | null }>((resolve) => {
    child.once("close", (code) => resolve({ code }));
    child.once("error", () => resolve({ code: -1 }));
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new ScreenStudioError("start_timeout", "Capture produced no frames", { hint: tail(stderr) })
      );
    }, READY_TIMEOUT_MS);
    let block: Record<string, string> = {};
    child.stdout.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        const eq = line.indexOf("=");
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim();
        block[key] = line.slice(eq + 1).trim();
        if (key !== "progress") continue;
        frames = Number(block.frame ?? frames) || frames;
        const outUs = Number(block.out_time_us ?? block.out_time_ms);
        if (!mediaStart && frames > 0 && Number.isFinite(outUs)) {
          mediaStart = Date.now() - Math.max(0, outUs) / 1000;
          clearTimeout(timer);
          resolve();
        }
        block = {};
      }
    });
    exited.then(({ code }) => {
      if (mediaStart) return;
      clearTimeout(timer);
      reject(
        options.classifyFailure?.(stderr) ??
          new ScreenStudioError("capture_failed", `FFmpeg exited (${code}) before capturing`, {
            hint: tail(stderr),
          })
      );
    });
  });

  exited.then(({ code }) => {
    if (!stopping)
      context.onFailure(
        new ScreenStudioError("capture_failed", `FFmpeg exited (${code}): ${tail(stderr)}`)
      );
  });

  return {
    mediaStartEpochMs: Math.round(mediaStart),
    uncertaintyMs: 250,
    clockMethod: "ffmpeg progress: now - out_time at the first report",
    geometry: options.geometry,
    pointerInPixels: "none",
    childPids: child.pid ? [child.pid] : [],
    stats: () => ({ frames }),
    async stop() {
      stopping = true;
      // SIGINT stops reading input at once; "q" on stdin is only polled
      // between frames and let ~2 s more media in.
      child.kill("SIGINT");
      const kill = setTimeout(() => child.kill("SIGKILL"), 15_000);
      await exited;
      clearTimeout(kill);
      return finalizeFragmented(partPath, finalPath);
    },
  };
}

// ---------------------------------------------------------------------------
// Synthetic source: lifecycle tests and demos without a browser or device
// ---------------------------------------------------------------------------

export interface TestPatternSourceSpec {
  kind: "test-pattern";
  size?: Size;
}

export function testPatternBackend(spec: TestPatternSourceSpec): CaptureBackend {
  const size = spec.size ?? { width: 1280, height: 720 };
  return {
    id: `test-pattern:${size.width}x${size.height}`,
    kind: "test-pattern",
    backend: "lavfi",
    label: `Test pattern ${size.width}x${size.height}`,
    details: { size },
    start: (context) =>
      startFfmpegCapture(
        [
          "-re",
          "-readrate_initial_burst",
          "0",
          "-f",
          "lavfi",
          "-i",
          `testsrc2=size=${size.width}x${size.height}:rate=${context.fps}`,
        ],
        context,
        { geometry: { viewport: size, media: size } }
      ),
  };
}

// ---------------------------------------------------------------------------
// macOS display via AVFoundation
// ---------------------------------------------------------------------------

export interface DisplaySourceSpec {
  kind: "display";
  /** Screen number as listed by `sources` (0 is the main display). */
  screen: number;
  /** Draw the system cursor into the pixels. Off by default: the renderer draws its own. */
  systemCursor?: boolean;
}

export async function listDisplays(): Promise<
  Array<{ screen: number; device: number; name: string }>
> {
  if (process.platform !== "darwin") return [];
  const result = await run(
    ffmpegBin(),
    ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
    {
      timeoutMs: 10_000,
    }
  );
  const displays: Array<{ screen: number; device: number; name: string }> = [];
  for (const line of result.stderr.split("\n")) {
    const match = /\[(\d+)\]\s+(Capture screen (\d+))/.exec(line);
    if (match)
      displays.push({ device: Number(match[1]), name: match[2], screen: Number(match[3]) });
  }
  return displays;
}

export async function displayBackend(spec: DisplaySourceSpec): Promise<CaptureBackend> {
  if (process.platform !== "darwin") {
    throw new ScreenStudioError(
      "source_unavailable",
      "Display capture is implemented for macOS only"
    );
  }
  const display = (await listDisplays()).find((d) => d.screen === spec.screen);
  if (!display) {
    throw new ScreenStudioError("source_not_found", `No display ${spec.screen}`, {
      hint: "Run `screen-studio sources` to list displays.",
    });
  }
  return {
    id: `display:${spec.screen}`,
    kind: "display",
    backend: "avfoundation",
    label: `Display ${spec.screen}`,
    details: { screen: spec.screen, avfoundationDevice: display.device },
    async start(context) {
      const capture = await startFfmpegCapture(
        [
          "-f",
          "avfoundation",
          "-framerate",
          String(context.fps),
          "-capture_cursor",
          spec.systemCursor ? "1" : "0",
          "-i",
          `${display.device}:none`,
        ],
        context,
        {
          classifyFailure: (stderr) =>
            /not authorized|permission|Failed to create|Input\/output error/i.test(stderr)
              ? new ScreenStudioError("permission_denied", "macOS denied screen recording", {
                  hint:
                    "Grant Screen Recording to the app that runs this command (Terminal, your editor, or Deus) " +
                    "in System Settings → Privacy & Security, then retry.",
                })
              : null,
        }
      );
      return { ...capture, pointerInPixels: spec.systemCursor ? "system-cursor" : "none" };
    },
  };
}
