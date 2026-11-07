#!/usr/bin/env node
/**
 * screen-studio — capture what an agent does, then render it.
 *
 * Built for agents: non-interactive, flags only, one JSON result per command
 * on stdout (errors too, with a code and a hint), diagnostics on stderr.
 * `start` hands the live recorder to a detached worker, so start, chapter
 * and stop can be separate processes.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { cuaTrajectory } from "../adapters/cua.js";
import { appendEvents, makeEvent, readManifest } from "../bundle/bundle.js";
import { ACTION_TYPES, type EventInput, type Manifest, type Rect } from "../bundle/schema.js";
import { listSources, parseSourceId, type SourceSpec } from "../capture/sources.js";
import { runWorker, startDetached, stopDetached } from "../daemon.js";
import { PRESETS } from "../direct/presets.js";
import { doctor } from "../doctor.js";
import { ScreenStudioError, toErrorInfo } from "../errors.js";
import { importVideo } from "../import.js";
import { ownerIsGone, startRecording } from "../recorder.js";
import { inspectBundle } from "../render/inspect.js";
import { renderBundle, type RenderOptions } from "../render/render.js";
import { parseBytes, parseDuration, parseSize } from "../util/units.js";

const VERSION = "0.2.0";
const CLI_ENTRY = fileURLToPath(import.meta.url);
/** dist/cli/index.js and src/cli/index.ts both sit two levels below the package. */
const SKILL_PATH = fileURLToPath(new URL("../../skills/screen-studio/SKILL.md", import.meta.url));

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

interface Args {
  command: string;
  positional: string[];
  flags: Map<string, string[]>;
  passthrough: string[];
}

const BOOLEAN_FLAGS = new Set([
  "help",
  "version",
  "stdin",
  "contact-sheet",
  "zoom",
  "no-zoom",
  "no-motion",
  "plain",
  "plan",
  "system-cursor",
]);

/** Flags that may stand alone or take a value: `stop --render` or `--render demo`. */
const OPTIONAL_VALUE_FLAGS = new Set(["render"]);

function parseArgs(argv: string[]): Args {
  const [command = "help", ...rest] = argv;
  const flags = new Map<string, string[]>();
  const positional: string[] = [];
  let passthrough: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--") {
      passthrough = rest.slice(i + 1);
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const key = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
      let value: string;
      if (eq >= 0) value = arg.slice(eq + 1);
      else if (BOOLEAN_FLAGS.has(key)) value = "true";
      else if (
        OPTIONAL_VALUE_FLAGS.has(key) &&
        (i + 1 >= rest.length || rest[i + 1].startsWith("--"))
      )
        value = "true";
      else if (i + 1 < rest.length) value = rest[++i];
      else throw new ScreenStudioError("invalid_argument", `--${key} needs a value`);
      flags.set(key, [...(flags.get(key) ?? []), value]);
    } else {
      positional.push(arg);
    }
  }
  return { command, positional, flags, passthrough };
}

const flag = (args: Args, name: string): string | undefined => args.flags.get(name)?.at(-1);
const has = (args: Args, name: string): boolean => args.flags.has(name);

function requireDir(args: Args, usage: string): string {
  const dir = args.positional[0];
  if (!dir)
    throw new ScreenStudioError("invalid_argument", "Missing recording directory", { hint: usage });
  return resolve(dir);
}

function parseRect(value: string): Rect {
  const parts = value.split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new ScreenStudioError("invalid_argument", `Invalid rect "${value}"`, {
      hint: "Use x,y,width,height",
    });
  }
  return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
}

function parseTime(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (value === "now") return Date.now();
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1e11) {
    throw new ScreenStudioError("invalid_argument", `Invalid time "${value}"`, {
      hint: "Use epoch milliseconds (Date.now()) or 'now'",
    });
  }
  return n;
}

function numberFlag(args: Args, name: string): number | undefined {
  const value = flag(args, name);
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n))
    throw new ScreenStudioError("invalid_argument", `--${name} must be a number`);
  return n;
}

function sourceSpec(args: Args): SourceSpec {
  const id = flag(args, "source");
  if (!id) {
    throw new ScreenStudioError("invalid_argument", "Missing --source", {
      hint: "Run `screen-studio sources` to list what can be recorded.",
    });
  }
  const spec = parseSourceId(id);
  const urlContains = flag(args, "url-contains");
  if (spec.kind === "browser" && urlContains) spec.urlContains = urlContains;
  if (
    spec.kind === "ios-simulator" &&
    (flag(args, "simulator-set") ?? process.env.SCREEN_STUDIO_SIMULATOR_SET)
  ) {
    spec.deviceSet = flag(args, "simulator-set") ?? process.env.SCREEN_STUDIO_SIMULATOR_SET;
  }
  if (spec.kind === "display" && has(args, "system-cursor")) spec.systemCursor = true;
  return spec;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function summary(dir: string, m: Manifest, extra: Record<string, unknown> = {}) {
  const live = m.status === "recording" || m.status === "starting" || m.status === "finalizing";
  return {
    ok: m.status !== "failed",
    bundle: dir,
    id: m.id,
    status: m.status,
    source: { id: m.source.id, kind: m.source.kind, label: m.source.label },
    ...(m.capture.startedAt ? { startedAt: new Date(m.capture.startedAt).toISOString() } : {}),
    ...(live && m.capture.startedAt ? { elapsedMs: Date.now() - m.capture.startedAt } : {}),
    ...(live && m.capture.startedAt
      ? {
          stopsAutomaticallyAt: new Date(
            m.capture.startedAt + m.capture.maxDurationMs
          ).toISOString(),
        }
      : {}),
    ...(m.capture.stopReason ? { stopReason: m.capture.stopReason } : {}),
    ...(live && ownerIsGone(m) ? { ownerAlive: false } : {}),
    ...(m.media
      ? {
          media: {
            path: join(dir, m.media.path),
            durationMs: m.media.durationMs,
            width: m.media.width,
            height: m.media.height,
            frames: m.media.frames,
            bytes: m.media.bytes,
          },
        }
      : {}),
    ...(m.capture.warnings.length ? { warnings: m.capture.warnings } : {}),
    ...(m.capture.error ? { error: m.capture.error } : {}),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdStart(args: Args): Promise<void> {
  const out = flag(args, "out");
  if (!out) throw new ScreenStudioError("invalid_argument", "Missing --out <directory>");
  const dir = resolve(out);
  const manifest = await startDetached({
    source: sourceSpec(args),
    out: dir,
    fps: numberFlag(args, "fps"),
    maxDurationMs: flag(args, "max-duration")
      ? parseDuration(flag(args, "max-duration")!)
      : undefined,
    maxBytes: flag(args, "max-size") ? parseBytes(flag(args, "max-size")!) : undefined,
    workerEntry: CLI_ENTRY,
    runtime: process.execPath,
  });
  print(
    summary(dir, manifest, {
      next: [
        `screen-studio chapter ${dir} "Step title"`,
        `screen-studio action ${dir} --type click --rect x,y,w,h`,
        `screen-studio stop ${dir}`,
      ],
    })
  );
}

async function cmdRecord(args: Args): Promise<void> {
  const out = flag(args, "out");
  if (!out) throw new ScreenStudioError("invalid_argument", "Missing --out <directory>");
  const dir = resolve(out);
  const maxDurationMs = parseDuration(
    flag(args, "max-duration") ?? (args.passthrough.length ? "10m" : "30s")
  );
  const recording = await startRecording({
    source: sourceSpec(args),
    out: dir,
    fps: numberFlag(args, "fps"),
    maxDurationMs,
    maxBytes: flag(args, "max-size") ? parseBytes(flag(args, "max-size")!) : undefined,
    reporter: "cli",
    log: (message) => process.stderr.write(`[screen-studio] ${message}\n`),
  });
  print({ type: "recording", ...summary(dir, recording.manifest) });
  const onSignal = () => void recording.stop("signal");
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  let exitCode: number | null = null;
  if (args.passthrough.length) {
    const [command, ...rest] = args.passthrough;
    const child = spawn(command, rest, {
      stdio: ["inherit", process.stderr, process.stderr],
      env: { ...process.env, SCREEN_STUDIO_BUNDLE: dir },
    });
    const exited = new Promise<number>((r) => {
      child.once("close", (code) => r(code ?? 1));
      child.once("error", () => r(127));
    });
    const first = await Promise.race([
      exited.then((code) => ({ code })),
      recording.finished.then(() => null),
    ]);
    if (first) {
      exitCode = first.code;
      await recording.stop("requested");
    } else {
      child.kill("SIGTERM");
      exitCode = await exited;
    }
  }
  const final = await recording.finished;
  print({
    type: "stopped",
    ...summary(dir, final),
    ...(exitCode !== null ? { commandExitCode: exitCode } : {}),
  });
  if (final.status !== "complete") process.exitCode = 1;
}

async function cmdStatus(args: Args): Promise<void> {
  const dir = requireDir(args, "screen-studio status <dir>");
  print(summary(dir, await readManifest(dir)));
}

async function addEvent(dir: string, input: EventInput): Promise<void> {
  const manifest = await readManifest(dir);
  if (manifest.status !== "recording" && input.at === undefined) {
    throw new ScreenStudioError("not_recording", `Recording is ${manifest.status}`, {
      hint: "Events without --at are stamped now; pass --at <epoch ms> to annotate a finished recording.",
    });
  }
  const event = makeEvent(input, "cli");
  await appendEvents(dir, [event]);
  const origin = manifest.clock?.mediaStartEpochMs;
  print({ ok: true, event, ...(origin !== undefined ? { mediaMs: event.at - origin } : {}) });
}

async function cmdAction(args: Args): Promise<void> {
  const dir = requireDir(args, "screen-studio action <dir> --type click --rect x,y,w,h");
  if (has(args, "stdin")) {
    // Adapters stream events as JSON Lines; each line is validated on its own.
    const manifest = await readManifest(dir);
    if (manifest.status !== "recording")
      throw new ScreenStudioError("not_recording", `Recording is ${manifest.status}`);
    let accepted = 0;
    const rejected: Array<{ line: number; error: string }> = [];
    let line = 0;
    for await (const text of createInterface({ input: process.stdin })) {
      line++;
      if (!text.trim()) continue;
      try {
        await appendEvents(dir, [makeEvent(JSON.parse(text) as EventInput, "cli")]);
        accepted++;
      } catch (err) {
        rejected.push({ line, error: (err as Error).message });
      }
    }
    print({ ok: rejected.length === 0, accepted, rejected });
    return;
  }
  const json = flag(args, "json");
  if (json) {
    await addEvent(dir, { kind: "action", ...(JSON.parse(json) as object) } as EventInput);
    return;
  }
  const type = flag(args, "type");
  if (!type || !(ACTION_TYPES as readonly string[]).includes(type)) {
    throw new ScreenStudioError(
      "invalid_argument",
      `--type must be one of: ${ACTION_TYPES.join(", ")}`
    );
  }
  const at = parseTime(flag(args, "at"));
  const duration = flag(args, "duration") ? parseDuration(flag(args, "duration")!) : undefined;
  const endAt =
    parseTime(flag(args, "end-at")) ??
    (duration !== undefined ? (at ?? Date.now()) + duration : undefined);
  const x = numberFlag(args, "x");
  const y = numberFlag(args, "y");
  await addEvent(dir, {
    kind: "action",
    type: type as (typeof ACTION_TYPES)[number],
    ...(at !== undefined ? { at } : {}),
    ...(endAt !== undefined ? { endAt } : {}),
    ...(x !== undefined && y !== undefined ? { point: { x, y } } : {}),
    ...(flag(args, "rect") ? { rect: parseRect(flag(args, "rect")!) } : {}),
    ...(flag(args, "space") ? { space: parseSize(flag(args, "space")!, "space") } : {}),
    ...(flag(args, "label") ? { label: flag(args, "label") } : {}),
    ...(flag(args, "url") ? { url: flag(args, "url") } : {}),
    ...(flag(args, "text") ? { text: flag(args, "text") } : {}),
  });
}

async function cmdChapter(args: Args): Promise<void> {
  const dir = requireDir(args, 'screen-studio chapter <dir> "Title"');
  const title = args.positional.slice(1).join(" ") || flag(args, "title");
  if (!title) throw new ScreenStudioError("invalid_argument", "Missing chapter title");
  const at = parseTime(flag(args, "at"));
  await addEvent(dir, { kind: "chapter", title, ...(at ? { at } : {}) });
}

async function cmdHold(args: Args): Promise<void> {
  const dir = requireDir(args, "screen-studio hold <dir> --for 2s");
  const reason = flag(args, "reason");
  const at = parseTime(flag(args, "at"));
  await addEvent(dir, {
    kind: "hold",
    durationMs: parseDuration(flag(args, "for") ?? "2s"),
    ...(reason ? { reason } : {}),
    ...(at ? { at } : {}),
  });
}

async function cmdFocus(args: Args): Promise<void> {
  const dir = requireDir(args, "screen-studio focus <dir> --rect x,y,w,h");
  const rect = flag(args, "rect");
  if (!rect) throw new ScreenStudioError("invalid_argument", "Missing --rect x,y,width,height");
  const label = flag(args, "label");
  const at = parseTime(flag(args, "at"));
  await addEvent(dir, {
    kind: "focus",
    rect: parseRect(rect),
    ...(flag(args, "for") ? { durationMs: parseDuration(flag(args, "for")!) } : {}),
    ...(flag(args, "space") ? { space: parseSize(flag(args, "space")!, "space") } : {}),
    ...(label ? { label } : {}),
    ...(at ? { at } : {}),
  });
}

async function cmdNote(args: Args): Promise<void> {
  const dir = requireDir(args, 'screen-studio note <dir> "text"');
  const text = args.positional.slice(1).join(" ");
  if (!text) throw new ScreenStudioError("invalid_argument", "Missing note text");
  const at = parseTime(flag(args, "at"));
  await addEvent(dir, { kind: "note", text, ...(at ? { at } : {}) });
}

async function cmdStop(args: Args): Promise<void> {
  const dir = requireDir(args, "screen-studio stop <dir>");
  const result = await stopDetached(dir);
  const extra: Record<string, unknown> = {
    alreadyStopped: result.alreadyStopped,
    recovered: result.recovered,
  };
  if (has(args, "render") && result.manifest.status === "complete") {
    const preset = flag(args, "render");
    const rendered = await renderBundle(dir, {
      ...renderOptions(args),
      ...(preset && preset !== "true" && !has(args, "preset") ? { preset } : {}),
    });
    extra.render = renderSummary(rendered);
  } else if (result.manifest.status === "complete") {
    extra.next = [
      `screen-studio render ${dir} --preset walkthrough`,
      `screen-studio inspect ${dir} --contact-sheet`,
    ];
  }
  print(summary(dir, result.manifest, extra));
  if (result.manifest.status !== "complete") process.exitCode = 1;
}

function renderOptions(args: Args): RenderOptions {
  const size = flag(args, "size");
  const background = flag(args, "background");
  const cursor = flag(args, "cursor");
  const frame = flag(args, "frame");
  const pacing = flag(args, "pacing");
  if (pacing && !["preserve", "compress", "cut"].includes(pacing)) {
    throw new ScreenStudioError("invalid_argument", "--pacing must be preserve, compress or cut");
  }
  return {
    ...(flag(args, "preset") ? { preset: flag(args, "preset") } : {}),
    ...(pacing ? { pacing: pacing as RenderOptions["pacing"] } : {}),
    ...(flag(args, "target-duration")
      ? { targetDurationMs: parseDuration(flag(args, "target-duration")!) }
      : {}),
    ...(flag(args, "name") ? { name: flag(args, "name") } : {}),
    ...(flag(args, "output") ? { output: flag(args, "output") } : {}),
    ...(size ? { size: size === "source" ? "source" : parseSize(size) } : {}),
    ...(numberFlag(args, "fps") ? { fps: numberFlag(args, "fps") } : {}),
    ...(cursor ? { cursor: cursor as RenderOptions["cursor"] } : {}),
    ...(frame ? { frame: frame as RenderOptions["frame"] } : {}),
    ...(background ? { background } : {}),
    ...(has(args, "no-zoom") ? { zoom: false } : has(args, "zoom") ? { zoom: true } : {}),
    ...(numberFlag(args, "max-zoom") ? { maxZoom: numberFlag(args, "max-zoom") } : {}),
    ...(flag(args, "title") ? { title: flag(args, "title") } : {}),
    ...(has(args, "no-motion") ? { motion: false } : {}),
    ...(has(args, "plain") ? { plain: true } : {}),
    ...(has(args, "plan") ? { planOnly: true } : {}),
    onProgress: ({ frame: f, frames }) =>
      process.stderr.write(`[screen-studio] rendered ${f}/${frames} frames\n`),
  };
}

function renderSummary(result: Awaited<ReturnType<typeof renderBundle>>) {
  return {
    name: result.name,
    output: result.outputPath,
    plan: result.planPath,
    ...(result.vttPath ? { chaptersVtt: result.vttPath } : {}),
    ...(result.posterPath ? { poster: result.posterPath } : {}),
    durationMs: Math.round(result.durationMs),
    sourceDurationMs: Math.round(result.sourceDurationMs),
    frames: result.frames,
    chapters: result.chapters.map((c) => ({ title: c.title, startMs: c.startMs })),
    shots: result.plan.camera.shots.length,
    ...(result.targetMet !== undefined ? { targetMet: result.targetMet } : {}),
    ...(result.warnings.length ? { warnings: result.warnings } : {}),
  };
}

async function cmdRender(args: Args): Promise<void> {
  const dir = requireDir(args, "screen-studio render <dir> [--preset walkthrough]");
  const result = await renderBundle(dir, renderOptions(args));
  print({
    ok: true,
    bundle: dir,
    planned: has(args, "plan"),
    ...renderSummary(result),
    ...(has(args, "plan") ? { pacing: result.plan.pacing, camera: result.plan.camera } : {}),
  });
}

async function cmdInspect(args: Args): Promise<void> {
  const dir = requireDir(args, "screen-studio inspect <dir>");
  const result = await inspectBundle(dir, {
    contactSheet: has(args, "contact-sheet"),
    render: flag(args, "render"),
  });
  print({
    ...summary(dir, result.manifest),
    clock: result.manifest.clock,
    geometry: result.manifest.geometry,
    events: result.events,
    chapters: result.chapters,
    renders: result.renders,
    ...(result.contactSheet ? { contactSheet: result.contactSheet } : {}),
  });
}

async function cmdImport(args: Args): Promise<void> {
  const cua = flag(args, "cua-trajectory");
  const video = args.positional[0] ?? (cua ? (await cuaTrajectory(cua)).videoPath : undefined);
  const out = flag(args, "out");
  if (!video || !out)
    throw new ScreenStudioError(
      "invalid_argument",
      "Usage: screen-studio import <video> --out <dir> (or --cua-trajectory DIR --out <dir>)"
    );
  const kind = flag(args, "kind");
  const manifest = await importVideo(video, out, {
    ...(flag(args, "events") ? { eventsPath: flag(args, "events") } : {}),
    ...(flag(args, "agent-device-telemetry")
      ? { agentDeviceTelemetry: flag(args, "agent-device-telemetry") }
      : {}),
    ...(cua ? { cuaTrajectory: cua } : {}),
    ...(numberFlag(args, "start-epoch-ms") !== undefined
      ? { startEpochMs: numberFlag(args, "start-epoch-ms") }
      : {}),
    ...(flag(args, "viewport") ? { viewport: parseSize(flag(args, "viewport")!, "viewport") } : {}),
    ...(kind ? { kind: kind as Manifest["source"]["kind"] } : {}),
  });
  print(summary(resolve(out), manifest, { next: [`screen-studio render ${resolve(out)}`] }));
}

async function cmdSources(args: Args): Promise<void> {
  const { sources, problems } = await listSources({
    cdp: args.flags.get("cdp"),
    deviceSet: flag(args, "simulator-set") ?? process.env.SCREEN_STUDIO_SIMULATOR_SET,
  });
  print({ ok: true, sources, ...(problems.length ? { problems } : {}) });
}

const HELP = `screen-studio ${VERSION} — record what an agent does, then render it

Capture produces a bundle: original video + timed events (actions, chapters,
holds, focus hints). Rendering is separate and repeatable; the original is
never modified.

  doctor                         Check FFmpeg, canvas, Xcode, agent-browser
  sources [--cdp URL]            List recordable sources and their IDs
  start --source ID --out DIR    Start recording in the background
        [--max-duration 10m] [--max-size 4GiB] [--fps 30]
        [--url-contains TEXT] [--simulator-set PATH]
  record --source ID --out DIR [--max-duration 30s] [-- COMMAND ...]
                                 Record in the foreground until the duration,
                                 Ctrl-C, or COMMAND exits ($SCREEN_STUDIO_BUNDLE)
  status DIR
  action DIR --type click|type|tap|swipe|… [--rect x,y,w,h | --x N --y N]
        [--label TEXT] [--url URL] [--duration 800ms] [--space WxH] [--at MS]
  action DIR --stdin             Stream events as JSON Lines
  chapter DIR "Title"            Mark the start of a section
  hold DIR [--for 2s]            Keep this moment at normal speed
  focus DIR --rect x,y,w,h       Ask the camera to show a region
  note DIR "text"                Annotation for editors
  stop DIR [--render [PRESET]]   Finalize (idempotent); optionally render
  render DIR [--preset walkthrough|demo|replay|review] [--pacing preserve|compress|cut]
        [--target-duration 30s] [--size 1920x1080|source] [--cursor auto|cua|arrow|touch|none]
        [--frame auto|browser|window|device|rounded|none] [--background midnight|paper|none|#hex]
        [--zoom | --no-zoom] [--max-zoom 1.6] [--title TEXT] [--name NAME] [--plan] [--plain]
  inspect DIR [--contact-sheet] [--render NAME]
  import VIDEO --out DIR [--events FILE.jsonl] [--start-epoch-ms N] [--viewport WxH]
        [--agent-device-telemetry FILE.json]
  import --cua-trajectory DIR --out DIR   A Cua driver trajectory (video + turns)
  presets
  skill                          Print the agent skill (SKILL.md): when and how to record

Source IDs: browser:http://127.0.0.1:9222 · browser:ws://…/devtools/page/ID ·
agent-browser:SESSION · ios-simulator:booted · display:0 · test-pattern:1280x720

Example:
  screen-studio start --source agent-browser:demo --out ./captures/login --max-duration 3m
  screen-studio chapter ./captures/login "Sign in"
  screen-studio stop ./captures/login --render --preset walkthrough
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "__worker") {
    // Exit as soon as the bundle is final; nothing left in flight (a slow
    // source lookup, a stray timer) should keep the worker alive.
    process.exit(await runWorker(args.positional[0]));
  }
  if (args.command === "--version" || args.command === "version") {
    print({ version: VERSION });
    return;
  }
  if (
    args.command === "help" ||
    args.command === "--help" ||
    args.command === "-h" ||
    has(args, "help")
  ) {
    process.stdout.write(HELP);
    return;
  }
  switch (args.command) {
    case "doctor": {
      const result = await doctor();
      print(result);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    case "sources":
      return cmdSources(args);
    case "start":
      return cmdStart(args);
    case "record":
      return cmdRecord(args);
    case "status":
      return cmdStatus(args);
    case "action":
    case "event":
      return cmdAction(args);
    case "chapter":
      return cmdChapter(args);
    case "hold":
      return cmdHold(args);
    case "focus":
      return cmdFocus(args);
    case "note":
      return cmdNote(args);
    case "stop":
      return cmdStop(args);
    case "render":
      return cmdRender(args);
    case "inspect":
      return cmdInspect(args);
    case "import":
      return cmdImport(args);
    case "skill":
      process.stdout.write(await readFile(SKILL_PATH, "utf8"));
      return;
    case "presets":
      print({
        presets: Object.values(PRESETS).map((p) => ({
          name: p.name,
          description: p.description,
          pacing: p.pacing,
        })),
      });
      return;
    default:
      throw new ScreenStudioError("invalid_argument", `Unknown command "${args.command}"`, {
        hint: "Run `screen-studio help`.",
      });
  }
}

main().catch((err) => {
  print({ ok: false, error: toErrorInfo(err) });
  if (!(err instanceof ScreenStudioError)) process.stderr.write(`${(err as Error).stack ?? err}\n`);
  process.exitCode = 1;
});
