/**
 * Detached capture for short-lived callers.
 *
 * A CLI `start` cannot own a recorder: it exits. It creates the bundle, spawns
 * a worker process that does (`screen-studio __worker <dir>`), and returns once
 * the worker reports real media. Later commands find the owner through the
 * manifest. Events never go through the worker — any process appends them to
 * events.jsonl directly — so the worker's only jobs are capture, deadline,
 * and finalization, and it stays responsive to stop.
 */
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { hostname } from "node:os";
import {
  BUNDLE_FILES,
  createBundle,
  currentOwner,
  readManifest,
  updateManifest,
} from "./bundle/bundle.js";
import type { Manifest } from "./bundle/schema.js";
import { parseSourceId, type SourceSpec } from "./capture/sources.js";
import { ScreenStudioError } from "./errors.js";
import {
  DEFAULT_FPS,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_DURATION_MS,
  isWorkerOf,
  recoverBundle,
  startRecording,
  type Recording,
} from "./recorder.js";
import { isAlive, stopGroup } from "./util/process.js";

export interface DetachedStartOptions {
  source: string | SourceSpec;
  out: string;
  fps?: number;
  maxDurationMs?: number;
  maxBytes?: number;
  /** Script that implements `__worker` (the CLI entry). */
  workerEntry: string;
  /** Runtime that executes it. Default: the current one. */
  runtime?: string;
  startTimeoutMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startDetached(options: DetachedStartOptions): Promise<Manifest> {
  const dir = resolve(options.out);
  const spec = typeof options.source === "string" ? parseSourceId(options.source) : options.source;
  const sourceId = typeof options.source === "string" ? options.source : spec.kind;
  const created = await createBundle(dir, {
    source: {
      id: sourceId,
      kind: "browser",
      backend: "pending",
      label: sourceId,
      details: { spec },
    },
    capture: {
      fps: options.fps ?? DEFAULT_FPS,
      maxDurationMs: options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS,
      maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
      requestedAt: Date.now(),
      warnings: [],
    },
  });

  const logPath = join(dir, BUNDLE_FILES.logs, "worker.log");
  const logFd = openSync(logPath, "a");
  const child = spawn(options.runtime ?? process.execPath, [options.workerEntry, "__worker", dir], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  closeSync(logFd);
  child.unref();
  const workerPid = child.pid;
  if (!workerPid)
    throw new ScreenStudioError("capture_failed", "Could not spawn the capture worker");
  // Register the owner now, so a stop during startup reaches the worker
  // instead of mistaking a slow start for a dead one.
  await updateManifest(dir, (m) => ({
    ...m,
    capture: { ...m.capture, owner: currentOwner("worker", workerPid) },
  }));

  const deadline = Date.now() + (options.startTimeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    const manifest = await readManifest(dir).catch(() => created);
    if (manifest.status === "recording") return manifest;
    if (manifest.status === "failed" || manifest.status === "complete") {
      const error = manifest.capture.error;
      throw new ScreenStudioError(
        (error?.code as ScreenStudioError["code"]) ?? "capture_failed",
        error?.message ?? "Capture failed to start",
        { hint: error?.hint, details: { bundle: dir } }
      );
    }
    if (!isAlive(workerPid)) {
      await stopGroup(workerPid);
      const log = await readFile(logPath, "utf8").catch(() => "");
      await markFailed(dir, "capture_failed", "The capture worker exited during start");
      throw new ScreenStudioError("capture_failed", "The capture worker exited during start", {
        hint: log.trim().split("\n").slice(-5).join("\n") || undefined,
        details: { bundle: dir },
      });
    }
    await sleep(100);
  }
  // The worker and every capture helper it spawned share its process group.
  await stopGroup(workerPid, 2_000);
  await recoverBundle(dir).catch(() => {});
  await markFailed(dir, "start_timeout", "Capture did not produce media in time");
  throw new ScreenStudioError("start_timeout", "Capture did not produce media in time", {
    hint: `See ${logPath}`,
    details: { bundle: dir },
  });
}

async function markFailed(dir: string, code: string, message: string): Promise<void> {
  await updateManifest(dir, (m) => {
    if (m.status === "complete" || m.status === "failed") return m;
    return {
      ...m,
      status: "failed",
      capture: { ...m.capture, error: { code, message }, stoppedAt: Date.now() },
    };
  }).catch(() => {});
}

export interface StopResult {
  manifest: Manifest;
  /** The recording had already stopped; nothing was signalled. */
  alreadyStopped: boolean;
  /** The owner had died; media was recovered from disk. */
  recovered: boolean;
}

/** Idempotent: a finished bundle is returned as-is. */
export async function stopDetached(
  dir: string,
  options: { timeoutMs?: number } = {}
): Promise<StopResult> {
  const root = resolve(dir);
  let manifest = await readManifest(root);
  if (manifest.status === "complete" || manifest.status === "failed") {
    return { manifest, alreadyStopped: true, recovered: false };
  }
  const owner = manifest.capture.owner;
  if (owner && owner.hostname !== hostname()) {
    throw new ScreenStudioError(
      "invalid_argument",
      `This recording is owned by ${owner.hostname}`,
      {
        hint: "Stop it on the machine that is recording.",
      }
    );
  }
  if (owner?.kind === "host" && isAlive(owner.pid)) {
    // An app or MCP server records in-process; signalling it would stop the app.
    throw new ScreenStudioError(
      "invalid_argument",
      `Process ${owner.pid} records this in-process; stop it through that app or MCP server`
    );
  }
  if (!owner || !(await isWorkerOf(owner.pid, root))) {
    return { manifest: await recoverBundle(root), alreadyStopped: false, recovered: true };
  }
  const pid = owner.pid;
  if (manifest.status !== "finalizing") process.kill(pid, "SIGINT");
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  while (Date.now() < deadline) {
    await sleep(100);
    manifest = await readManifest(root);
    if (manifest.status === "complete" || manifest.status === "failed") {
      return { manifest, alreadyStopped: false, recovered: false };
    }
    if (!isAlive(pid)) {
      return { manifest: await recoverBundle(root), alreadyStopped: false, recovered: true };
    }
  }
  throw new ScreenStudioError("stop_timeout", "The recorder did not finalize in time", {
    hint: `It is still running (pid ${pid}). Retry stop, or inspect ${join(root, BUNDLE_FILES.logs)}`,
  });
}

/** Entry point of the detached worker process. Returns the exit code. */
export async function runWorker(dir: string): Promise<number> {
  const root = resolve(dir);
  const manifest = await readManifest(root);
  const spec = (manifest.source.details.spec as SourceSpec | undefined) ?? manifest.source.id;
  // Handlers go in before startup: a stop during a slow start (resolving a
  // source, waiting for the first frame) must still be a clean stop.
  const abort = new AbortController();
  let recording: Recording | null = null;
  const onSignal = (signal: NodeJS.Signals) => {
    if (recording) void recording.stop(signal === "SIGINT" ? "requested" : "signal");
    else abort.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);
  try {
    recording = await startRecording({
      signal: abort.signal,
      source: spec,
      out: root,
      existing: true,
      fps: manifest.capture.fps,
      maxDurationMs: manifest.capture.maxDurationMs,
      maxBytes: manifest.capture.maxBytes,
      log: (message) => console.error(`[worker] ${message}`),
    });
  } catch (err) {
    console.error(`[worker] start failed: ${(err as Error).message}`);
    return 1;
  }
  const final = await recording.finished;
  return final.status === "complete" ? 0 : 1;
}
