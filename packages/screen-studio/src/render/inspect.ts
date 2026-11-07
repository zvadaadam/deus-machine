import { mkdir, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BUNDLE_FILES, readEvents, readManifest } from "../bundle/bundle.js";
import type { Manifest } from "../bundle/schema.js";
import { ScreenStudioError } from "../errors.js";
import { ffmpegBin, probeMedia } from "../util/ffmpeg.js";
import { runOk } from "../util/process.js";
import type { RenderPlan } from "./render.js";

export interface InspectResult {
  dir: string;
  manifest: Manifest;
  events: {
    total: number;
    skipped: number;
    byKind: Record<string, number>;
    actions: Record<string, number>;
  };
  chapters: Array<{ title: string; mediaMs: number }>;
  renders: Array<{
    name: string;
    path: string;
    durationMs: number;
    preset: string;
    frames: number;
  }>;
  contactSheet?: string;
}

/**
 * A recording's facts plus, optionally, a contact sheet: a grid of evenly
 * spaced frames so an agent can check the content before sharing it.
 */
export async function inspectBundle(
  dir: string,
  options: { contactSheet?: boolean; render?: string } = {}
): Promise<InspectResult> {
  const root = resolve(dir);
  const manifest = await readManifest(root);
  const { events, skipped } = await readEvents(root);
  const byKind: Record<string, number> = {};
  const actions: Record<string, number> = {};
  for (const event of events) {
    byKind[event.kind] = (byKind[event.kind] ?? 0) + 1;
    if (event.kind === "action") actions[event.type] = (actions[event.type] ?? 0) + 1;
  }
  const origin = manifest.clock?.mediaStartEpochMs ?? 0;
  const chapters = events.flatMap((e) =>
    e.kind === "chapter" ? [{ title: e.title, mediaMs: e.at - origin }] : []
  );

  const renders: InspectResult["renders"] = [];
  for (const file of await readdir(join(root, BUNDLE_FILES.renders)).catch(() => [] as string[])) {
    if (!file.endsWith(".json")) continue;
    try {
      const plan = JSON.parse(
        await readFile(join(root, BUNDLE_FILES.renders, file), "utf8")
      ) as RenderPlan;
      if (plan.format !== "screen-studio/render-plan") continue;
      renders.push({
        name: plan.name,
        path: plan.output.path,
        durationMs: plan.output.durationMs,
        preset: plan.preset,
        frames: plan.output.frames,
      });
    } catch {
      // not a plan
    }
  }

  const result: InspectResult = {
    dir: root,
    manifest,
    events: { total: events.length, skipped, byKind, actions },
    chapters,
    renders,
  };
  if (options.contactSheet) {
    let video: string;
    if (options.render) {
      const match = renders.find((r) => r.name === options.render);
      if (!match)
        throw new ScreenStudioError("invalid_argument", `No render named "${options.render}"`);
      video = join(root, match.path);
    } else if (manifest.media) {
      video = join(root, manifest.media.path);
    } else {
      throw new ScreenStudioError("media_missing", "The recording has no finalized media yet");
    }
    const outDir = join(root, BUNDLE_FILES.analysis);
    await mkdir(outDir, { recursive: true });
    const sheet = join(outDir, `contact-sheet${options.render ? `-${options.render}` : ""}.png`);
    result.contactSheet = await contactSheet(video, sheet);
  }
  return result;
}

export async function contactSheet(
  video: string,
  outPath: string,
  columns = 4,
  rows = 3
): Promise<string> {
  const { durationMs } = await probeMedia(video);
  const count = columns * rows;
  const rate = count / Math.max(0.5, durationMs / 1000);
  await runOk(
    ffmpegBin(),
    [
      "-v",
      "error",
      "-y",
      "-i",
      video,
      "-vf",
      `fps=${rate.toFixed(4)},scale=400:-2,tile=${columns}x${rows}:padding=6:margin=6:color=0x111724`,
      "-frames:v",
      "1",
      outPath,
    ],
    { timeoutMs: 120_000 }
  );
  return outPath;
}
