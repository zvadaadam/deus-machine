import { copyFile, readFile, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import {
  BUNDLE_FILES,
  appendEvents,
  createBundle,
  makeEvent,
  writeManifest,
} from "./bundle/bundle.js";
import type { EventInput, Manifest, SourceKind } from "./bundle/schema.js";
import { agentDeviceEvents } from "./adapters/agent-device.js";
import { cuaTrajectory } from "./adapters/cua.js";
import { ScreenStudioError } from "./errors.js";
import { probeMedia, sha256File, verifyDecodable } from "./util/ffmpeg.js";
import type { Size } from "./util/units.js";

export interface ImportOptions {
  /** JSON Lines of events in the bundle schema (`id` optional). */
  eventsPath?: string;
  /** agent-device gesture telemetry exported with the video. */
  agentDeviceTelemetry?: string;
  /** A Cua driver trajectory directory recorded with this video. */
  cuaTrajectory?: string;
  /**
   * Epoch ms of the video's first frame. Without it, event `at` values are
   * read as milliseconds from the start of the video.
   */
  startEpochMs?: number;
  /** Coordinate space of event points and rects. Default: the video's pixels. */
  viewport?: Size;
  kind?: SourceKind;
  label?: string;
  pointerInPixels?: NonNullable<Manifest["media"]>["pointerInPixels"];
}

/** Wrap an existing video (from agent-device, Playwright, a screen recorder…) in a bundle. */
export async function importVideo(
  video: string,
  out: string,
  options: ImportOptions = {}
): Promise<Manifest> {
  const source = resolve(video);
  const probe = await probeMedia(source);
  const cua = options.cuaTrajectory ? await cuaTrajectory(options.cuaTrajectory) : null;
  const warnings = cua?.skipped
    ? [`${cua.skipped} Cua turns reported an error and were left out.`]
    : [];
  const dir = resolve(out);
  const created = await createBundle(dir, {
    source: {
      id: `file:${source}`,
      kind:
        options.kind ?? (options.agentDeviceTelemetry ? "ios-simulator" : cua ? "display" : "file"),
      backend: "import",
      label: options.label ?? (cua ? "Cua desktop" : (source.split("/").pop() ?? "video")),
      details: { importedFrom: source },
    },
    capture: {
      fps: 30,
      maxDurationMs: Math.max(1, probe.durationMs),
      maxBytes: Number.MAX_SAFE_INTEGER,
      requestedAt: Date.now(),
      warnings,
    },
  });
  const ext = extname(source).toLowerCase() || ".mp4";
  const mediaRel = join(BUNDLE_FILES.media, `screen${ext}`);
  await copyFile(source, join(dir, mediaRel));
  const decoded = await verifyDecodable(join(dir, mediaRel));
  const origin = options.startEpochMs ?? 0;
  // Adapters time events from the start of the video; the bundle's clock may not.
  const fromVideoStart = (input: EventInput): EventInput =>
    input.kind === "action"
      ? {
          ...input,
          ...(input.at !== undefined ? { at: input.at + origin } : {}),
          ...(input.endAt !== undefined ? { endAt: input.endAt + origin } : {}),
        }
      : input;

  if (options.agentDeviceTelemetry) {
    const inputs = await agentDeviceEvents(options.agentDeviceTelemetry);
    await appendEvents(
      dir,
      inputs.map((input) => makeEvent(fromVideoStart(input), "agent-device"))
    );
  }
  if (cua)
    await appendEvents(
      dir,
      cua.events.map((input) => makeEvent(fromVideoStart(input), "cua"))
    );
  if (options.eventsPath) {
    const lines = (await readFile(resolve(options.eventsPath), "utf8"))
      .split("\n")
      .filter((l) => l.trim());
    const events = lines.map((line, i) => {
      try {
        return makeEvent(JSON.parse(line) as EventInput, "import");
      } catch (err) {
        throw new ScreenStudioError(
          "invalid_argument",
          `Event line ${i + 1}: ${(err as Error).message}`
        );
      }
    });
    await appendEvents(dir, events);
  }

  const size = { width: probe.width, height: probe.height };
  const manifest: Manifest = {
    ...created,
    status: "complete",
    capture: {
      ...created.capture,
      startedAt: origin,
      stoppedAt: origin + decoded.durationMs,
      stopReason: "requested",
    },
    clock: {
      mediaStartEpochMs: origin,
      uncertaintyMs: options.startEpochMs === undefined ? 0 : 100,
      method:
        options.startEpochMs === undefined
          ? "imported: event times are media milliseconds"
          : "imported with a given start time",
    },
    geometry: { viewport: options.viewport ?? size, media: size },
    media: {
      path: mediaRel,
      sha256: await sha256File(join(dir, mediaRel)),
      bytes: (await stat(join(dir, mediaRel))).size,
      durationMs: decoded.durationMs || probe.durationMs,
      width: probe.width,
      height: probe.height,
      codec: probe.codec,
      frameRate: probe.frameRate,
      frames: decoded.frames,
      audio: probe.audio,
      pointerInPixels:
        options.pointerInPixels ??
        (options.agentDeviceTelemetry ? "touches" : cua ? "system-cursor" : "unknown"),
    },
  };
  await writeManifest(dir, manifest);
  return manifest;
}
