import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { ScreenStudioError } from "../errors.js";
import { run, runOk, tail } from "./process.js";

export const ffmpegBin = (): string => process.env.SCREEN_STUDIO_FFMPEG ?? "ffmpeg";
export const ffprobeBin = (): string => process.env.SCREEN_STUDIO_FFPROBE ?? "ffprobe";

export interface MediaProbe {
  durationMs: number;
  width: number;
  height: number;
  codec: string;
  /** Nominal rate as reported by the container, e.g. "30/1". */
  frameRate: string;
  frames?: number;
  audio: boolean;
  format: string;
}

/** Probe a media file. Throws `media_invalid` when it has no decodable video stream. */
export async function probeMedia(path: string): Promise<MediaProbe> {
  const result = await run(
    ffprobeBin(),
    ["-v", "error", "-show_format", "-show_streams", "-of", "json", path],
    { timeoutMs: 20_000 }
  );
  if (result.code !== 0) {
    throw new ScreenStudioError(
      "media_invalid",
      `ffprobe could not read ${path}: ${tail(result.stderr)}`
    );
  }
  const info = JSON.parse(result.stdout) as {
    streams?: Array<Record<string, unknown>>;
    format?: Record<string, unknown>;
  };
  const video = info.streams?.find((s) => s.codec_type === "video");
  if (!video) throw new ScreenStudioError("media_invalid", `${path} has no video stream`);
  const seconds = Number(video.duration ?? info.format?.duration ?? 0);
  const frames = Number(video.nb_frames);
  return {
    durationMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0,
    width: Number(video.width),
    height: Number(video.height),
    codec: String(video.codec_name ?? "unknown"),
    frameRate: String(video.avg_frame_rate ?? video.r_frame_rate ?? "0/0"),
    ...(Number.isFinite(frames) && frames > 0 ? { frames } : {}),
    audio: Boolean(info.streams?.some((s) => s.codec_type === "audio")),
    format: String(info.format?.format_name ?? "unknown"),
  };
}

/**
 * Decode every frame and count them. Slower than a probe, but it is the only
 * proof that a capture finalized into playable media.
 */
export async function verifyDecodable(
  path: string
): Promise<{ frames: number; durationMs: number }> {
  const result = await run(
    ffprobeBin(),
    [
      "-v",
      "error",
      "-count_frames",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=nb_read_frames:format=duration",
      "-of",
      "json",
      path,
    ],
    { timeoutMs: 120_000 }
  );
  if (result.code !== 0) {
    throw new ScreenStudioError("media_invalid", `Media is not decodable: ${tail(result.stderr)}`);
  }
  const info = JSON.parse(result.stdout) as {
    streams?: Array<{ nb_read_frames?: string }>;
    format?: { duration?: string };
  };
  const frames = Number(info.streams?.[0]?.nb_read_frames ?? 0);
  if (!(frames > 0)) throw new ScreenStudioError("media_invalid", "Media decoded to zero frames");
  return { frames, durationMs: Math.round(Number(info.format?.duration ?? 0) * 1000) };
}

export async function ffmpegVersion(): Promise<string | null> {
  try {
    const out = await runOk(ffmpegBin(), ["-hide_banner", "-version"], { timeoutMs: 10_000 });
    return /ffmpeg version (\S+)/.exec(out)?.[1] ?? "unknown";
  } catch {
    return null;
  }
}

export async function hasEncoder(name: string): Promise<boolean> {
  try {
    const out = await runOk(ffmpegBin(), ["-hide_banner", "-encoders"], { timeoutMs: 10_000 });
    return new RegExp(`\\s${name}\\s`).test(out);
  } catch {
    return false;
  }
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/** Write one frame of `video` at `atMs` as an image (format from the extension). */
export async function extractFrame(
  video: string,
  atMs: number,
  outPath: string,
  width?: number
): Promise<void> {
  await runOk(
    ffmpegBin(),
    [
      "-v",
      "error",
      "-y",
      "-ss",
      (Math.max(0, atMs) / 1000).toFixed(3),
      "-i",
      video,
      "-frames:v",
      "1",
      ...(width ? ["-vf", `scale=${width}:-2`] : []),
      "-q:v",
      "3",
      outPath,
    ],
    { timeoutMs: 30_000 }
  );
}

/** Lossless container rewrite, e.g. fragmented MP4 → faststart MP4. */
export async function remux(input: string, output: string): Promise<void> {
  await runOk(
    ffmpegBin(),
    [
      "-v",
      "error",
      "-y",
      "-i",
      input,
      "-map",
      "0",
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      output,
    ],
    { timeoutMs: 120_000 }
  );
}
