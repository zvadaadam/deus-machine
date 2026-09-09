// apps/backend/src/services/aap/apps.service.ts
// Public API for AAP host. Routes + query-engine + boot hooks go through
// this module; nothing else in services/aap/ is meant to be imported
// directly from outside.
//
// State model: a module-scope `Map<runningAppId, RunningAppEntry>`. Runtime
// state is transient by nature — a live OS process tied to a port —
// persisting it in SQLite created a stale-data risk for no benefit, since
// there's one writer and durability is undesired. The Map is authoritative;
// terminal-state entries (stopped, crashed) are removed so the resource
// semantically means "currently live."
//
// Cross-restart orphan cleanup: a flat PID journal (see pid-journal.ts).
// Written on spawn, read + cleared on boot. Kills zombies left behind by
// any ungraceful backend exit.
//
// Effects on every state transition:
//   1. Map write
//   2. invalidate(["apps","running_apps"]) for WS subscribers
//   3. apps:launched q:event on successful ready (Phase 4 consumer)

import { spawnSync, type ChildProcess } from "node:child_process";

import type { Manifest } from "@shared/aap/manifest";
import { substituteTemplate, type TemplateVars } from "@shared/aap/template";
import type {
  InstalledApp,
  LaunchAppArgs,
  LaunchAppResult,
  RunningApp,
  RunningStatus,
} from "@shared/aap/types";
import { getErrorMessage } from "@shared/lib/errors";
import { uuidv7 } from "@shared/lib/uuid";

import { invalidate } from "../query-engine";
import { broadcast } from "../ws.service";

import { allocateFreePort } from "./port-allocator";
import { isProcessAlive, killByPid, spawnApp, stopChild, waitForReady } from "./lifecycle";
import { registerMcpForRunningApp, unregisterMcpForRunningApp } from "./mcp-bridge";
import { clearPids, readPids, recordPid } from "./pid-journal";
import {
  getInstalledApp,
  loadInstalledApps,
  readAppSkills,
  type InstalledAppEntry,
} from "./registry";
import { ensureStorageDirs, injectGitignore } from "./storage";

/** Broadcast a q:event frame to all connected WS clients.
 *  Mirrors the helper in pty.service / simulator-context / fs-watcher —
 *  Deus's established convention for service-to-frontend push. */
function pushEvent(event: string, data: unknown): void {
  broadcast(JSON.stringify({ type: "q:event", event, data }));
}

// ----------------------------------------------------------------------------
// internal types — not part of the public AAP surface
// ----------------------------------------------------------------------------

/** Backend-private row in the runningApps Map. Carries the `ChildProcess`
 *  handle, which must NEVER cross a process boundary (WS, RPC). The public
 *  view (`RunningApp` in shared/aap/types.ts) is what gets serialized. */
interface RunningAppEntry {
  id: string;
  appId: string;
  workspaceId: string | null;
  pid: number;
  port: number;
  url: string;
  /** Fully-resolved MCP HTTP URL — `agent.tools.url` with `{port}` substituted.
   *  Cached at spawn time so the mcp-bridge unregister path doesn't need to
   *  recompute it after the entry has been deleted from the Map. */
  mcpUrl: string;
  status: RunningStatus;
  startedAt: string;
  child: ChildProcess;
}

// ----------------------------------------------------------------------------
// module state
// ----------------------------------------------------------------------------

/** Authoritative store of currently-live apps. Terminal states (stopped,
 *  crashed) are not kept — absence means "not running." */
const runningApps = new Map<string, RunningAppEntry>();

/** In-flight `launchApp` promises keyed by `${appId}::${workspaceId ?? ""}`.
 *  Prevents the TOCTOU race where two concurrent callers both pass the
 *  dedupe check and both spawn children. Second caller joins the first's
 *  in-flight promise — same result, one spawn. Cleared in a `finally`. */
const launching = new Map<string, Promise<LaunchAppResult>>();

// ----------------------------------------------------------------------------
// public read API
// ----------------------------------------------------------------------------

export function listApps(): InstalledApp[] {
  return loadInstalledApps().map(({ manifest }) => ({
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    icon: manifest.icon,
    bootstrap: manifest.agent.bootstrap,
  }));
}

/** Fetch the concatenated skill content for an installed app. Empty string
 *  if the manifest declares no skills. Throws if the appId is unknown —
 *  callers (agent tool, q:command handler) should surface the error to the
 *  agent, not swallow it. Pure read; no running state is touched. */
export function readAppSkill(appId: string): string {
  const entry = getInstalledApp(appId);
  if (!entry) throw new Error(`aap: app not found: ${appId}`);
  return readAppSkills(entry);
}

export function getRunningApps(workspaceId?: string | null): RunningApp[] {
  const entries = [...runningApps.values()];
  const matches =
    workspaceId === undefined ? entries : entries.filter((e) => e.workspaceId === workspaceId);
  return matches.map(toView);
}

// ----------------------------------------------------------------------------
// launch
// ----------------------------------------------------------------------------

export function launchApp(args: LaunchAppArgs): Promise<LaunchAppResult> {
  const installed = getInstalledApp(args.appId);
  if (!installed) throw new Error(`aap: app not found: ${args.appId}`);

  // Dedupe (fast path): already-running entry matching (appId, workspaceId).
  const existing = findDedupeEntry(args.appId, args.workspaceId);
  if (existing) {
    return Promise.resolve({
      runningAppId: existing.id,
      url: existing.url,
      bootstrap: installed.manifest.agent.bootstrap,
    });
  }

  // Dedupe (in-flight path): a launch for the same key is already spawning.
  // Join its promise so two concurrent callers get one spawn + the same url.
  const key = `${args.appId}::${args.workspaceId ?? ""}`;
  const inFlight = launching.get(key);
  if (inFlight) return inFlight;

  const promise = doLaunch(installed, args).finally(() => {
    launching.delete(key);
  });
  launching.set(key, promise);
  return promise;
}

async function doLaunch(
  installed: InstalledAppEntry,
  args: LaunchAppArgs
): Promise<LaunchAppResult> {
  // ─── Phase 1: validate + resolve. Pure planning, no side effects. ────────
  validateRequires(installed.manifest);

  const port = await allocateFreePort();

  const storageWorkspace = resolveOptionalPath(installed.manifest.storage.workspace, args, port);
  const storageGlobal = resolveOptionalPath(installed.manifest.storage.global, args, port);

  const vars: TemplateVars & { port: number } = {
    port,
    workspace: args.workspacePath,
    userData: args.userDataDir,
    storage: { workspace: storageWorkspace, global: storageGlobal },
  };

  // ─── Phase 2: prepare the filesystem. Side effects start here. ──────────
  await ensureStorageDirs({ workspace: storageWorkspace, global: storageGlobal });
  if (storageWorkspace) await injectGitignore(args.workspacePath, storageWorkspace);

  const runningAppId = uuidv7();
  const url = substituteTemplate(installed.manifest.ui.url, vars);
  // Separate from `url` (the user-facing UI url). mcpUrl is where the agent's
  // MCP client connects; manifests almost always point these at different
  // paths on the same port (e.g. "/" vs "/mcp").
  const mcpUrl = substituteTemplate(installed.manifest.agent.tools.url, vars);

  // ─── Phase 3: spawn + register. Child is alive after this point, so every
  //             exit path must clean up both the process and the Map entry. ─
  // AbortController for the ready probe. Aborts on spawn error (so we don't
  // wait the full probe timeout when the binary is missing) and on the
  // probe's own deadline.
  const probeController = new AbortController();
  let spawnError: Error | null = null;

  let spawned;
  try {
    spawned = spawnApp({
      manifest: installed.manifest,
      vars,
      packageRoot: installed.packageRoot,
      onExit: (code, signal, stderrTail) => handleChildExit(runningAppId, code, signal, stderrTail),
      onError: (err) => {
        spawnError = err;
        probeController.abort();
      },
    });
  } catch (err) {
    // spawnApp throws synchronously when the OS rejects the spawn outright
    // (e.g., bun-level ENOENT detection before the async "error" event).
    // The async "error" handler attached inside spawnApp has already caught
    // the EventEmitter emission, so the backend stays alive — we just need
    // to surface the failure with consistent messaging.
    logLaunchFailure({ appId: args.appId, workspaceId: args.workspaceId, kind: "spawn", err });
    throw formatLaunchError(args.appId, "spawn", err);
  }

  const entry: RunningAppEntry = {
    id: runningAppId,
    appId: args.appId,
    workspaceId: args.workspaceId,
    pid: spawned.pid,
    port,
    url,
    mcpUrl,
    status: "starting",
    startedAt: new Date().toISOString(),
    child: spawned.child,
  };
  runningApps.set(runningAppId, entry);
  // Record pid for cross-restart orphan cleanup. Recorded even if the ready
  // probe later fails — the child might already be running and we want the
  // next boot to find it if the probe-timeout kill was ineffective.
  recordPid(spawned.pid);
  invalidate(["apps", "running_apps"]);

  // ─── Phase 4: probe + finalize. Succeed → flip to ready + broadcast. ────
  const probeDeadline = setTimeout(
    () => probeController.abort(),
    installed.manifest.launch.ready.timeoutMs
  );

  try {
    await waitForReady(installed.manifest.launch.ready, port, probeController.signal);
  } catch (err) {
    clearTimeout(probeDeadline);
    try {
      spawned.child.kill("SIGKILL");
    } catch {
      /* already dead */
    }
    runningApps.delete(runningAppId);
    invalidate(["apps", "running_apps"]);

    // Two paths arrive here:
    //   1. Async spawn error (ENOENT, EACCES) — `spawnError` was set in onError
    //      and the probe was aborted. Root cause is the spawn failure.
    //   2. Probe genuinely timed out or the caller aborted. Include captured
    //      stdout + stderr so the user can see why the app didn't become ready.
    const capturedSpawnError = spawnError as Error | null;
    const streams = {
      stdout: spawned.getStdout(),
      stderr: spawned.getStderr(),
    };
    if (capturedSpawnError) {
      logLaunchFailure({
        appId: args.appId,
        workspaceId: args.workspaceId,
        kind: "spawn",
        err: capturedSpawnError,
        ...streams,
      });
      throw formatLaunchError(args.appId, "spawn", capturedSpawnError);
    }
    logLaunchFailure({
      appId: args.appId,
      workspaceId: args.workspaceId,
      kind: "ready",
      err,
      ...streams,
    });
    throw formatLaunchError(args.appId, "ready", err, streams);
  }
  clearTimeout(probeDeadline);

  // Race guard: onExit may have fired during the probe window (unlikely once
  // we abort on spawn error, but possible for a child that exits cleanly
  // right as /health starts responding). We check two things — the Map entry
  // AND the child's own exit state — because the exit event may be queued
  // but not yet drained when waitForReady resolves.
  const current = runningApps.get(runningAppId);
  if (!current) {
    throw new Error(`aap: ${args.appId} exited during probe`);
  }
  if (spawned.child.exitCode !== null || spawned.child.signalCode !== null) {
    runningApps.delete(runningAppId);
    invalidate(["apps", "running_apps"]);
    throw new Error(`aap: ${args.appId} exited during probe`);
  }

  current.status = "ready";
  invalidate(["apps", "running_apps"]);

  // Register the app's MCP server with the agent-server — fire-and-forget.
  //
  // Critical: we must NOT await here. Awaiting deadlocks the agent-initiated
  // launch path: this very call chain is resolving a `launch_app` tool call
  // whose response the CLI is blocked on. `registerAppMcp` → agent-server →
  // `query.setMcpServers` → CLI control request. The CLI can't process the
  // control request while it's waiting on the tool result, and the tool
  // result can't return until register finishes. Fire-and-forget breaks the
  // cycle: this function returns → tool returns → CLI becomes free →
  // `setMcpServers` processes → new `mcp__app__*` tools appear.
  //
  // Symmetric with `unregisterMcpForRunningApp` in handleChildExit (fire-and-
  // forget for different-but-related reasons; see that call site).
  void registerMcpForRunningApp({ appId: args.appId, mcpUrl });
  pushEvent("apps:launched", {
    appId: args.appId,
    workspaceId: args.workspaceId,
    runningAppId,
    url,
  });

  return { runningAppId, url, bootstrap: installed.manifest.agent.bootstrap };
}

// ----------------------------------------------------------------------------
// stop
// ----------------------------------------------------------------------------

export async function stopApp(runningAppId: string): Promise<void> {
  const entry = runningApps.get(runningAppId);
  if (!entry) return;
  if (entry.status === "stopping") return;

  const installed = getInstalledApp(entry.appId);
  const stopTimeoutMs = installed?.manifest.lifecycle.stopTimeoutMs ?? 5_000;

  entry.status = "stopping";
  invalidate(["apps", "running_apps"]);

  await stopChild(entry.child, stopTimeoutMs);
  // handleChildExit fires via the onExit hook and removes the entry.
}

export async function stopAppsForWorkspace(workspaceId: string): Promise<void> {
  const targets = [...runningApps.values()].filter((e) => e.workspaceId === workspaceId);
  await Promise.all(targets.map((e) => stopApp(e.id)));
}

// ----------------------------------------------------------------------------
// boot + shutdown hooks
// ----------------------------------------------------------------------------

/** Called once at backend boot, BEFORE anything tries to launch an app.
 *  Reads the PID journal, SIGKILLs any still-alive PIDs (orphans from a
 *  previous ungraceful shutdown), and clears the journal. Synchronous. */
export function sweepOrphanApps(): void {
  const pids = readPids();
  let killed = 0;
  for (const pid of pids) {
    if (isProcessAlive(pid)) {
      killByPid(pid);
      killed++;
    }
  }
  clearPids();
  if (pids.length > 0) {
    console.log(`[AAP] Orphan sweep: found ${pids.length}, killed ${killed}`);
  }
}

/** Graceful-shutdown hook. Sends SIGTERM to every live app child. Called
 *  synchronously from the backend's SIGINT/SIGTERM handler — we don't await
 *  because the handler needs to exit quickly; surviving children will be
 *  caught by sweepOrphanApps on next boot. */
export function stopAllApps(): void {
  for (const entry of runningApps.values()) {
    // Mark as stopping so the onExit handler logs "aap:app-stopped" rather
    // than "aap:app-crashed" — this is intentional termination.
    entry.status = "stopping";
    try {
      entry.child.kill("SIGTERM");
    } catch {
      /* already dead */
    }
  }
}

// ----------------------------------------------------------------------------
// internals
// ----------------------------------------------------------------------------

// ----------------------------------------------------------------------------
// error formatting + audit logging
// ----------------------------------------------------------------------------

/** Single source of truth for the shape of a launch-failure error.
 *  - `kind: "spawn"` — the process never started (ENOENT, EACCES, missing CLI
 *    requirement). The `err.message` typically contains the kernel error.
 *  - `kind: "ready"` — the process started but never became ready (probe
 *    timeout or the child exited during the probe). Prepend the err, then the
 *    captured stderr/stdout so the user sees why. */
function formatLaunchError(
  appId: string,
  kind: "spawn" | "ready",
  err: unknown,
  streams: { stdout?: string; stderr?: string } = {}
): Error {
  const verb = kind === "spawn" ? "failed to spawn" : "did not become ready";
  const stderr = (streams.stderr ?? "").trim();
  const stdout = (streams.stdout ?? "").trim();
  const tail = [stderr && `stderr: ${stderr}`, stdout && `stdout: ${stdout}`]
    .filter(Boolean)
    .join("\n");
  return new Error(`aap: ${appId} ${verb} — ${getErrorMessage(err)}${tail ? `\n${tail}` : ""}`);
}

/** Log a launch failure with a grep-friendly prefix. Matches Deus's
 *  `[PREFIX] message` convention — the details object gets util.inspect-ed
 *  into readable multi-line output by Node's console. */
function logLaunchFailure(args: {
  appId: string;
  workspaceId: string | null;
  kind: "spawn" | "ready";
  err: unknown;
  stderr?: string;
  stdout?: string;
}): void {
  console.warn(`[AAP] Launch failed: ${args.appId}`, {
    kind: args.kind,
    workspaceId: args.workspaceId,
    error: getErrorMessage(args.err),
    stderrTail: args.stderr?.slice(-1_024).trim() || undefined,
    stdoutTail: args.stdout?.slice(-1_024).trim() || undefined,
  });
}

function validateRequires(manifest: Manifest): void {
  for (const req of manifest.requires) {
    if (req.type === "platform") {
      if (req.os && req.os !== process.platform) {
        throw new Error(
          `aap: ${manifest.id} requires platform os=${req.os}, got ${process.platform}`
        );
      }
      if (req.arch && req.arch !== process.arch) {
        throw new Error(`aap: ${manifest.id} requires arch=${req.arch}, got ${process.arch}`);
      }
    }
    if (req.type === "cli" && !isCliOnPath(req.name)) {
      // Manifest authors can provide an install hint per requirement — use it.
      // Much better UX than the kernel's "spawn ENOENT xcrun".
      const hint = req.install ? ` ${req.install}` : "";
      throw new Error(
        `aap: ${manifest.id} requires CLI "${req.name}" but it was not found on PATH.${hint}`
      );
    }
  }
}

function isCliOnPath(name: string): boolean {
  // `command -v` is POSIX and honours shell builtins + PATH lookup. On macOS
  // it covers xcrun, git, node, bun, etc. without needing `which`.
  try {
    const { status } = spawnSync("sh", ["-c", `command -v ${JSON.stringify(name)}`], {
      stdio: "ignore",
      timeout: 2_000,
    });
    return status === 0;
  } catch {
    return false;
  }
}

function resolveOptionalPath(
  template: string | undefined,
  args: LaunchAppArgs,
  port: number
): string | undefined {
  if (!template) return undefined;
  return substituteTemplate(template, {
    port,
    workspace: args.workspacePath,
    userData: args.userDataDir,
  });
}

function findDedupeEntry(appId: string, workspaceId: string | null): RunningAppEntry | undefined {
  // Exclude "stopping" entries — their child is being killed; returning one
  // as "already running" would hand the caller a URL pointing at a dying
  // process. A user who Stop + Launches in quick succession must spawn fresh.
  for (const e of runningApps.values()) {
    if (e.appId === appId && e.workspaceId === workspaceId && e.status !== "stopping") {
      return e;
    }
  }
  return undefined;
}

/**
 * Child-exit handler. Called from spawnApp's onExit hook. We log a structured
 * audit line (in place of a persisted DB row) and drop the entry — terminal
 * state is represented by absence, not by an in-map marker.
 */
function handleChildExit(
  runningAppId: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  stderrTail: string
): void {
  const entry = runningApps.get(runningAppId);
  if (!entry) return;
  const wasIntentional = entry.status === "stopping";
  const trimmed = stderrTail.slice(-1_024).trim();

  // Audit line — replaces the SQLite row as our post-mortem surface.
  // Sentry + stdout capture it. Format matches Deus's `[PREFIX] msg` convention.
  const fn = wasIntentional ? console.log : console.warn;
  fn(`[AAP] App ${wasIntentional ? "stopped" : "crashed"}: ${entry.appId}`, {
    runningAppId,
    workspaceId: entry.workspaceId,
    pid: entry.pid,
    exitCode: code,
    signal,
    stderrTail: trimmed || undefined,
  });

  // NOTE: we deliberately do NOT remove this pid from the journal here.
  // removePid would be a non-atomic read-modify-write that races with
  // concurrent child exits (Promise.all in stopAppsForWorkspace). Dead pids
  // are harmless — the boot sweep's `kill -0` check filters them before any
  // SIGKILL. Journal stays append-only across a session; it's cleared on
  // every boot. Matches the design in pid-journal.ts's header.
  runningApps.delete(runningAppId);
  invalidate(["apps", "running_apps"]);

  // Notify the frontend so it can close any Browser tabs pointing at this
  // app's URL — the port is dead, a refresh would just error. Symmetric
  // with the `apps:launched` event in `doLaunch`. Fires for both intentional
  // stops and unexpected crashes; the UX is the same either way.
  pushEvent("apps:stopped", {
    appId: entry.appId,
    workspaceId: entry.workspaceId,
    runningAppId,
    url: entry.url,
  });

  // Unregister the app's MCP server from the agent-server. Best-effort —
  // fire-and-forget (this is a sync handler called from child.on('exit')).
  // If we awaited here we'd either block the event loop or make this whole
  // function async and force every caller to retrofit async handling.
  void unregisterMcpForRunningApp({ appId: entry.appId, mcpUrl: entry.mcpUrl });
}

function toView(entry: RunningAppEntry): RunningApp {
  return {
    id: entry.id,
    appId: entry.appId,
    workspaceId: entry.workspaceId,
    pid: entry.pid,
    port: entry.port,
    url: entry.url,
    status: entry.status,
    startedAt: entry.startedAt,
  };
}
