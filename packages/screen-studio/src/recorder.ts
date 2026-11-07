import { appendFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  BUNDLE_FILES,
  appendEvents,
  createBundle,
  currentOwner,
  makeEvent,
  readManifest,
  writeManifest,
} from "./bundle/bundle.js";
import type {
  ActionEvent,
  BundleEvent,
  ChapterEvent,
  EventInput,
  FocusEvent,
  HoldEvent,
  Manifest,
  NoteEvent,
  Rect,
  StopReason,
} from "./bundle/schema.js";
import type { ActiveCapture, CaptureBackend } from "./capture/backend.js";
import { finalizeFragmented } from "./capture/cdp.js";
import { resolveSource, type SourceSpec } from "./capture/sources.js";
import { ScreenStudioError, toErrorInfo } from "./errors.js";
import { probeMedia, sha256File, verifyDecodable } from "./util/ffmpeg.js";
import { commandLine, isAlive, stopGroup } from "./util/process.js";

export const DEFAULT_FPS = 30;
export const DEFAULT_MAX_DURATION_MS = 10 * 60_000;
export const DEFAULT_MAX_BYTES = 4 * 1024 ** 3;

export interface StartRecordingOptions {
  /** A source ID (`ios-simulator:booted`), a spec, or an already resolved backend. */
  source: string | SourceSpec | CaptureBackend;
  /** Bundle directory. Must be new or empty unless `existing` is set. */
  out: string;
  fps?: number;
  /** Hard capture deadline. The recorder stops itself; nothing else has to. */
  maxDurationMs?: number;
  maxBytes?: number;
  /** The bundle was already created in `starting` state (detached CLI worker). */
  existing?: boolean;
  /** Recorded as `by` on events added through this handle. */
  reporter?: string;
  /** Abort a start in progress: the bundle ends failed (or, once media flows, stopped). */
  signal?: AbortSignal;
  log?: (message: string) => void;
}

export type ActionInput = Omit<Extract<EventInput, { kind: "action" }>, "kind">;

const isBackend = (value: unknown): value is CaptureBackend =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as CaptureBackend).start === "function";

/**
 * Start capturing into a bundle. Resolves once media is actually flowing —
 * the first frame is encoded and media time zero is known — or throws.
 */
export async function startRecording(options: StartRecordingOptions): Promise<Recording> {
  const dir = resolve(options.out);
  const fps = options.fps ?? DEFAULT_FPS;
  const maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const sourceLabel =
    typeof options.source === "string"
      ? options.source
      : isBackend(options.source)
        ? options.source.id
        : options.source.kind;

  let manifest: Manifest = options.existing
    ? await readManifest(dir)
    : await createBundle(dir, {
        source: {
          id: sourceLabel,
          kind: "browser",
          backend: "pending",
          label: sourceLabel,
          details: {},
        },
        capture: { fps, maxDurationMs, maxBytes, requestedAt: Date.now(), warnings: [] },
      });
  if (options.existing && manifest.status !== "starting") {
    throw new ScreenStudioError("invalid_argument", `Bundle is ${manifest.status}, not starting`);
  }

  const logPath = join(dir, BUNDLE_FILES.logs, "recorder.log");
  const log = (message: string) => {
    options.log?.(message);
    appendFile(logPath, `${new Date().toISOString()} ${message}\n`).catch(() => {});
  };

  const recording = new Recording(dir, manifest, log, options.reporter);
  const onAbort = () => void recording.stop("requested");
  if (options.signal?.aborted) onAbort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    // A stop while resolving (agent-browser can take seconds) wins at once.
    const backend = isBackend(options.source)
      ? options.source
      : await Promise.race([
          resolveSource(options.source),
          recording.stopSignal.then(() => {
            throw new ScreenStudioError("aborted", "Stopped before capture started");
          }),
        ]);
    if (recording.stopRequested) {
      throw new ScreenStudioError("aborted", "Stopped before capture started");
    }
    // A detached worker was registered as owner when it was spawned; keep it.
    const owner =
      manifest.capture.owner?.pid === process.pid ? manifest.capture.owner : currentOwner("host");
    manifest = {
      ...manifest,
      source: {
        id: backend.id,
        kind: backend.kind,
        backend: backend.backend,
        label: backend.label,
        details: { ...manifest.source.details, ...backend.details },
      },
      capture: { ...manifest.capture, owner },
    };
    await recording.save(manifest);
    log(`starting ${backend.backend} capture of ${backend.label}`);
    await recording.begin(backend);
  } catch (err) {
    await recording.fail(err);
    throw err;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
  return recording;
}

export class Recording {
  readonly dir: string;
  private manifestState: Manifest;
  private capture: ActiveCapture | null = null;
  /** A backend start in flight; stop waits for it instead of racing it. */
  private starting: Promise<ActiveCapture> | null = null;
  private stopping: Promise<Manifest> | null = null;
  private deadline: ReturnType<typeof setTimeout> | null = null;
  private progress: ReturnType<typeof setInterval> | null = null;
  private failure: Error | null = null;
  private writes: Promise<void> = Promise.resolve();
  private resolveFinished!: (manifest: Manifest) => void;
  private resolveStopSignal!: () => void;
  /** @internal Resolves when stop is first requested. */
  readonly stopSignal: Promise<void> = new Promise((resolve) => (this.resolveStopSignal = resolve));

  /** Settles when the bundle is finalized, whatever stopped it. */
  readonly finished: Promise<Manifest>;

  constructor(
    dir: string,
    manifest: Manifest,
    private readonly log: (message: string) => void,
    private readonly reporter?: string
  ) {
    this.dir = dir;
    this.manifestState = manifest;
    this.finished = new Promise((resolve) => (this.resolveFinished = resolve));
  }

  get id(): string {
    return this.manifestState.id;
  }

  get manifest(): Manifest {
    return this.manifestState;
  }

  get isRecording(): boolean {
    return this.manifestState.status === "recording";
  }

  /** @internal */
  get stopRequested(): boolean {
    return this.stopping !== null;
  }

  /** @internal Writes are queued so a late progress update can never overwrite the final state. */
  save(manifest: Manifest): Promise<void> {
    this.manifestState = manifest;
    const write = this.writes.then(() => writeManifest(this.dir, manifest));
    this.writes = write.catch(() => {});
    return write;
  }

  /** @internal */
  async begin(backend: CaptureBackend): Promise<void> {
    const { fps, maxDurationMs, maxBytes } = this.manifestState.capture;
    this.starting = backend.start({
      mediaDir: join(this.dir, BUNDLE_FILES.media),
      fps,
      log: this.log,
      onSourceLost: (reason) => {
        this.log(`source lost: ${reason}`);
        this.warn(reason);
        void this.stop("source-lost");
      },
      onGeometry: (viewport) => {
        void appendEvents(this.dir, [makeEvent({ kind: "geometry", viewport }, "recorder")]);
      },
      onEvent: (event) => {
        try {
          void appendEvents(this.dir, [makeEvent(event, "page")]);
        } catch (err) {
          this.log(`dropped an observed event: ${(err as Error).message}`);
        }
      },
      onFailure: (error) => {
        this.log(`capture failure: ${error.message}`);
        this.failure = error;
        void this.stop("error");
      },
    });
    const capture = await this.starting;
    this.capture = capture;
    const m = this.manifestState;
    const started: Manifest = {
      ...m,
      capture: {
        ...m.capture,
        startedAt: capture.mediaStartEpochMs,
        owner: { ...(m.capture.owner ?? currentOwner()), childPids: capture.childPids },
      },
      clock: {
        mediaStartEpochMs: capture.mediaStartEpochMs,
        uncertaintyMs: capture.uncertaintyMs,
        method: capture.clockMethod,
      },
      ...(capture.geometry ? { geometry: capture.geometry } : {}),
    };
    // Stopped while starting (signal, lost source): finalize owns it now, and
    // completes it with this clock.
    if (this.stopping) {
      this.manifestState = started;
      return;
    }
    await this.save({ ...started, status: "recording" });
    this.log(`recording; media zero at ${new Date(capture.mediaStartEpochMs).toISOString()}`);
    if (this.stopping) return;

    const remaining = Math.max(0, capture.mediaStartEpochMs + maxDurationMs - Date.now());
    this.deadline = setTimeout(() => void this.stop("deadline"), remaining);
    this.progress = setInterval(() => void this.tick(maxBytes), 1_000);
  }

  private async tick(maxBytes: number): Promise<void> {
    if (!this.capture || this.stopping) return;
    const bytes = await mediaBytes(join(this.dir, BUNDLE_FILES.media));
    const frames = this.capture.stats().frames ?? -1;
    if (this.stopping) return;
    await this.save({
      ...this.manifestState,
      capture: {
        ...this.manifestState.capture,
        progress: { frames, bytes, updatedAt: Date.now() },
      },
    }).catch(() => {});
    if (bytes >= maxBytes) void this.stop("size-limit");
  }

  private warn(message: string): void {
    const capture = this.manifestState.capture;
    if (!capture.warnings.includes(message)) capture.warnings.push(message);
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  async event<T extends BundleEvent = BundleEvent>(input: EventInput): Promise<T> {
    if (this.manifestState.status !== "recording") {
      throw new ScreenStudioError("not_recording", `Recording is ${this.manifestState.status}`);
    }
    const event = makeEvent(input, this.reporter);
    await appendEvents(this.dir, [event]);
    return event as T;
  }

  action(input: ActionInput): Promise<ActionEvent> {
    return this.event<ActionEvent>({ kind: "action", ...input } as EventInput);
  }

  chapter(title: string, at?: number): Promise<ChapterEvent> {
    return this.event<ChapterEvent>({ kind: "chapter", title, ...(at ? { at } : {}) });
  }

  hold(durationMs: number, reason?: string): Promise<HoldEvent> {
    return this.event<HoldEvent>({ kind: "hold", durationMs, ...(reason ? { reason } : {}) });
  }

  focus(
    rect: Rect,
    options: { label?: string; durationMs?: number; space?: { width: number; height: number } } = {}
  ): Promise<FocusEvent> {
    return this.event<FocusEvent>({ kind: "focus", rect, ...options });
  }

  note(text: string): Promise<NoteEvent> {
    return this.event<NoteEvent>({ kind: "note", text });
  }

  // -------------------------------------------------------------------------
  // Stop
  // -------------------------------------------------------------------------

  /** Stop and finalize. Safe to call repeatedly; later calls get the same result. */
  stop(reason: StopReason = "requested"): Promise<Manifest> {
    this.resolveStopSignal();
    this.stopping ??= this.finalize(reason);
    return this.stopping;
  }

  private async finalize(reason: StopReason): Promise<Manifest> {
    if (this.deadline) clearTimeout(this.deadline);
    if (this.progress) clearInterval(this.progress);
    const stoppedAt = Date.now();
    await this.save({ ...this.manifestState, status: "finalizing" }).catch(() => {});
    this.log(`stopping (${reason})`);
    let final: Manifest;
    try {
      const capture = this.capture ?? (await this.starting?.catch(() => null)) ?? null;
      if (!capture) throw new ScreenStudioError("aborted", "Stopped before capture started");
      const finalized = await capture.stop();
      for (const warning of finalized.warnings) this.warn(warning);
      if (this.failure) this.warn(`Capture ended early: ${this.failure.message}`);
      final = await completeManifest(this.dir, this.manifestState, finalized.path, {
        stoppedAt,
        reason,
        pointerInPixels: capture.pointerInPixels,
      });
    } catch (err) {
      final = failedManifest(this.manifestState, err, { stoppedAt, reason });
    }
    await this.save(final).catch(() => {});
    this.log(`finalized: ${final.status}`);
    this.resolveFinished(final);
    return final;
  }

  /** @internal Record a failure during start, stopping a capture that did begin. */
  async fail(err: unknown): Promise<void> {
    if (this.stopping) {
      await this.stopping;
      return;
    }
    if (this.deadline) clearTimeout(this.deadline);
    if (this.progress) clearInterval(this.progress);
    await this.capture?.stop().catch(() => {});
    const final = failedManifest(this.manifestState, err, {
      stoppedAt: Date.now(),
      reason: "error",
    });
    await this.save(final).catch(() => {});
    this.resolveFinished(final);
  }
}

async function mediaBytes(mediaDir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(mediaDir).catch(() => [] as string[])) {
    total += await stat(join(mediaDir, entry))
      .then((s) => s.size)
      .catch(() => 0);
  }
  return total;
}

/** Verify the media decodes, then record its measured facts. */
async function completeManifest(
  dir: string,
  manifest: Manifest,
  mediaPath: string,
  stop: {
    stoppedAt: number;
    reason: StopReason;
    pointerInPixels: NonNullable<Manifest["media"]>["pointerInPixels"];
  }
): Promise<Manifest> {
  const probe = await probeMedia(mediaPath);
  const decoded = await verifyDecodable(mediaPath);
  const media: NonNullable<Manifest["media"]> = {
    path: relative(dir, mediaPath),
    sha256: await sha256File(mediaPath),
    bytes: (await stat(mediaPath)).size,
    durationMs: decoded.durationMs || probe.durationMs,
    width: probe.width,
    height: probe.height,
    codec: probe.codec,
    frameRate: probe.frameRate,
    frames: decoded.frames,
    audio: probe.audio,
    pointerInPixels: stop.pointerInPixels,
  };
  const mediaSize = { width: probe.width, height: probe.height };
  return {
    ...manifest,
    status: "complete",
    capture: {
      ...manifest.capture,
      stoppedAt: stop.stoppedAt,
      stopReason: stop.reason,
      progress: { frames: decoded.frames, bytes: media.bytes, updatedAt: Date.now() },
    },
    geometry: manifest.geometry
      ? { ...manifest.geometry, media: mediaSize }
      : { viewport: mediaSize, media: mediaSize },
    media,
  };
}

function failedManifest(
  manifest: Manifest,
  err: unknown,
  stop: { stoppedAt: number; reason: StopReason }
): Manifest {
  return {
    ...manifest,
    status: "failed",
    capture: {
      ...manifest.capture,
      stoppedAt: stop.stoppedAt,
      stopReason: stop.reason,
      error: toErrorInfo(err),
    },
  };
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

/** True when the manifest's owner process is gone (same host only). */
export function ownerIsGone(manifest: Manifest): boolean {
  const owner = manifest.capture.owner;
  if (!owner) return manifest.status !== "complete" && manifest.status !== "failed";
  return !isAlive(owner.pid);
}

/** Whether `pid` is still the detached worker recording `dir` (PIDs get reused). */
export async function isWorkerOf(pid: number, dir: string): Promise<boolean> {
  if (!isAlive(pid)) return false;
  const command = await commandLine(pid);
  // No `ps` (Windows): trust liveness.
  return command === null || (command.includes("__worker") && command.includes(resolve(dir)));
}

/**
 * Finalize a bundle whose recorder died without stopping: stop orphaned
 * helpers, then keep whatever media made it to disk. Fragmented MP4 is
 * playable up to its last fragment. Call only once the owner is gone.
 */
export async function recoverBundle(dir: string): Promise<Manifest> {
  const manifest = await readManifest(dir);
  if (manifest.status === "complete" || manifest.status === "failed") return manifest;
  const owner = manifest.capture.owner;
  if (owner?.kind === "worker" && !isAlive(owner.pid)) {
    // A detached worker leads its process group and its capture helpers are
    // in it. While any of them lives the group ID cannot be reused, so this
    // only ever reaches the recording's own orphans.
    await stopGroup(owner.pid);
  } else {
    for (const pid of owner?.childPids ?? []) {
      const command = await commandLine(pid);
      if (!command || !/ffmpeg|simctl|xcrun/.test(command)) continue;
      try {
        process.kill(pid, "SIGINT");
      } catch {
        continue;
      }
      for (let i = 0; i < 100 && isAlive(pid); i++) await new Promise((r) => setTimeout(r, 100));
      if (isAlive(pid)) process.kill(pid, "SIGKILL");
    }
  }
  const mediaDir = join(dir, BUNDLE_FILES.media);
  const entries = await readdir(mediaDir).catch(() => [] as string[]);
  const stoppedAt = manifest.capture.progress?.updatedAt ?? Date.now();
  let final: Manifest;
  try {
    let mediaPath: string;
    if (entries.includes("screen.part.mp4")) {
      mediaPath = (
        await finalizeFragmented(join(mediaDir, "screen.part.mp4"), join(mediaDir, "screen.mp4"))
      ).path;
    } else if (entries.includes("screen.mp4")) {
      mediaPath = join(mediaDir, "screen.mp4");
    } else {
      throw new ScreenStudioError("media_missing", "The recorder died before writing media");
    }
    final = await completeManifest(dir, manifest, mediaPath, {
      stoppedAt,
      reason: "owner-lost",
      pointerInPixels: "unknown",
    });
    final.capture.warnings.push(
      `The recorder process exited without stopping; recovered ${(final.media!.durationMs / 1000).toFixed(1)} s of media.`
    );
  } catch (err) {
    final = failedManifest(manifest, err, { stoppedAt, reason: "owner-lost" });
  }
  await writeManifest(dir, final);
  return final;
}
