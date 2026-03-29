#!/usr/bin/env node

/**
 * screen-studio CLI — agent-friendly screen recording tool.
 *
 * Designed for AI agents: non-interactive, all flags, structured output,
 * actionable errors, idempotent commands.
 *
 * Usage:
 *   screen-studio start [--output path.mp4]
 *   screen-studio event <sessionId> --type click --x 500 --y 300
 *   screen-studio chapter <sessionId> --title "Login flow"
 *   screen-studio status <sessionId>
 *   screen-studio stop <sessionId> [--watermark "text"]
 *   screen-studio list
 */

import { SessionManager } from "../mcp/session-manager.js";

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------

// Each CLI command is stateless. State is persisted to a JSON file so that
// `stop` can reconstruct the session created by `start`. The CLI runs in
// events-only mode — capture is handled by the MCP server.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STATE_DIR = join(tmpdir(), "screen-studio");
const STATE_FILE = join(STATE_DIR, "sessions.json");

interface PersistedSessionConfig {
  sourceSize: { width: number; height: number };
  outputSize: { width: number; height: number };
  fps: number;
  deviceFrame: string;
}

interface PersistedState {
  sessions: Record<
    string,
    {
      config: Record<string, unknown>;
      /** Resolved config needed for post-processing in cmdStop. */
      resolvedConfig: PersistedSessionConfig;
      events: Array<{ type: string; x: number; y: number; t: number; meta?: Record<string, unknown> }>;
      chapters: Array<{ title: string; timestamp: number; eventIndex: number }>;
      startTime: number;
      endTime?: number;
      status: string;
      outputPath?: string;
    }
  >;
}

function loadState(): PersistedState {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    }
  } catch {
    // Corrupted state, start fresh
  }
  return { sessions: {} };
}

/**
 * Save state atomically via writeFileSync. For small JSON payloads (<64KB)
 * writeFileSync is effectively atomic on POSIX systems and Windows.
 * A race condition between concurrent CLI invocations is theoretically
 * possible but acceptable for v1 — agents rarely issue parallel commands
 * to the same session. A proper file lock can be added if needed.
 */
function saveState(state: PersistedState): void {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// Arg parsing — minimal, no dependencies
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { command: string; positional: string[]; flags: Record<string, string | boolean> } {
  const args = argv.slice(2);
  const command = args[0] ?? "help";
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const raw = arg.slice(2);
      // Support --flag=value syntax (e.g. --fps=60)
      const eqIdx = raw.indexOf("=");
      if (eqIdx !== -1) {
        const key = raw.slice(0, eqIdx);
        const value = raw.slice(eqIdx + 1);
        flags[key] = value;
      } else {
        const key = raw;
        const next = args[i + 1];
        if (next && !next.startsWith("--")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positional.push(arg);
    }
  }

  return { command, positional, flags };
}

function requireFlag(flags: Record<string, string | boolean>, name: string, command: string): string {
  const val = flags[name];
  if (val === undefined || val === true) {
    error(`Missing required flag --${name}`, `screen-studio ${command} --${name} <value>`);
  }
  return val as string;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function output(data: Record<string, unknown>): void {
  console.log(JSON.stringify(data));
}

function error(message: string, hint?: string): never {
  const err: Record<string, string> = { error: message };
  if (hint) err.hint = hint;
  console.error(JSON.stringify(err));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdStart(flags: Record<string, string | boolean>): Promise<void> {
  const state = loadState();

  // Parse flags once with defaults
  const sourceWidth = typeof flags["source-width"] === "string" ? parseInt(flags["source-width"]) : 1920;
  const sourceHeight = typeof flags["source-height"] === "string" ? parseInt(flags["source-height"]) : 1080;
  const outputWidth = typeof flags["output-width"] === "string" ? parseInt(flags["output-width"]) : 1920;
  const outputHeight = typeof flags["output-height"] === "string" ? parseInt(flags["output-height"]) : 1080;
  const fps = typeof flags.fps === "string" ? parseInt(flags.fps) : 30;
  const deviceFrame = typeof flags["device-frame"] === "string" ? flags["device-frame"] as "browser-chrome" | "macos-window" | "none" : undefined;

  const sessionManager = new SessionManager();
  const sessionId = await sessionManager.create({
    outputPath: typeof flags.output === "string" ? flags.output : undefined,
    sourceWidth,
    sourceHeight,
    outputWidth,
    outputHeight,
    fps,
    deviceFrame,
    captureMethod: "none",
    display: typeof flags.display === "string" ? flags.display : undefined,
  });

  // Persist the session with resolved config for post-processing in cmdStop
  state.sessions[sessionId] = {
    config: flags as Record<string, unknown>,
    resolvedConfig: {
      sourceSize: { width: sourceWidth, height: sourceHeight },
      outputSize: { width: outputWidth, height: outputHeight },
      fps,
      deviceFrame: deviceFrame ?? "none",
    },
    events: [],
    chapters: [],
    startTime: Date.now(),
    status: "recording",
    outputPath: typeof flags.output === "string" ? flags.output : join(tmpdir(), `recording-${sessionId}.mp4`),
  };
  saveState(state);

  output({
    session_id: sessionId,
    status: "recording",
    output_path: state.sessions[sessionId].outputPath,
  });
}

function cmdEvent(positional: string[], flags: Record<string, string | boolean>): void {
  const sessionId = positional[0];
  if (!sessionId) {
    error("Missing session ID", "screen-studio event <session_id> --type click --x 500 --y 300");
  }

  const state = loadState();
  const session = state.sessions[sessionId];
  if (!session) {
    error(
      `Session not found: ${sessionId}`,
      `Active sessions: ${Object.keys(state.sessions).join(", ") || "none"}. Use 'screen-studio list' to see all.`,
    );
  }
  if (session.status !== "recording") {
    error(`Session ${sessionId} is not recording (status: ${session.status})`);
  }

  const type = requireFlag(flags, "type", `event ${sessionId}`);
  const x = parseFloat(requireFlag(flags, "x", `event ${sessionId}`));
  const y = parseFloat(requireFlag(flags, "y", `event ${sessionId}`));
  const t = Date.now() - session.startTime;

  const validTypes = ["click", "type", "scroll", "navigate", "screenshot", "idle", "drag"];
  if (!validTypes.includes(type)) {
    error(
      `Invalid event type: '${type}'`,
      `Valid types: ${validTypes.join(", ")}`,
    );
  }

  const meta: Record<string, unknown> = {};
  if (flags.text) meta.text = flags.text;
  if (flags.url) meta.url = flags.url;
  if (flags.direction) meta.direction = flags.direction;
  if (flags["element-rect"]) {
    try {
      meta.elementRect = JSON.parse(flags["element-rect"] as string);
    } catch {
      error("Invalid --element-rect JSON", 'Use: --element-rect \'{"x":100,"y":200,"width":50,"height":30}\'');
    }
  }

  session.events.push({ type, x, y, t, meta: Object.keys(meta).length > 0 ? meta : undefined });
  saveState(state);

  output({
    recorded: true,
    event_index: session.events.length - 1,
    timestamp_ms: t,
  });
}

function cmdChapter(positional: string[], flags: Record<string, string | boolean>): void {
  const sessionId = positional[0];
  if (!sessionId) {
    error("Missing session ID", "screen-studio chapter <session_id> --title 'Chapter name'");
  }

  const state = loadState();
  const session = state.sessions[sessionId];
  if (!session) {
    error(`Session not found: ${sessionId}`, "Use 'screen-studio list' to see active sessions.");
  }
  if (session.status !== "recording") {
    error(`Session ${sessionId} is not recording (status: ${session.status})`);
  }

  const title = requireFlag(flags, "title", `chapter ${sessionId}`);
  const timestamp = Date.now() - session.startTime;

  session.chapters.push({
    title,
    timestamp,
    eventIndex: session.events.length,
  });
  saveState(state);

  output({
    chapter_index: session.chapters.length - 1,
    timestamp_ms: timestamp,
    title,
  });
}

function cmdStatus(positional: string[]): void {
  const sessionId = positional[0];
  if (!sessionId) {
    error("Missing session ID", "screen-studio status <session_id>");
  }

  const state = loadState();
  const session = state.sessions[sessionId];
  if (!session) {
    error(`Session not found: ${sessionId}`, "Use 'screen-studio list' to see active sessions.");
  }

  const endTime = session.endTime ?? Date.now();
  output({
    session_id: sessionId,
    status: session.status,
    duration_s: (endTime - session.startTime) / 1000,
    event_count: session.events.length,
    chapter_count: session.chapters.length,
    output_path: session.outputPath,
  });
}

async function cmdStop(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const sessionId = positional[0];
  if (!sessionId) {
    error("Missing session ID", "screen-studio stop <session_id>");
  }

  const state = loadState();
  const session = state.sessions[sessionId];
  if (!session) {
    error(`Session not found: ${sessionId}`, "Use 'screen-studio list' to see active sessions.");
  }
  if (session.status !== "recording") {
    error(`Session ${sessionId} is not recording (status: ${session.status})`);
  }

  // Create a temporary manager and replay events through the engine
  const manager = new SessionManager();
  const cfg = session.resolvedConfig;
  const tempId = await manager.create({
    sourceWidth: cfg.sourceSize.width,
    sourceHeight: cfg.sourceSize.height,
    outputWidth: cfg.outputSize.width,
    outputHeight: cfg.outputSize.height,
    fps: cfg.fps,
    deviceFrame: cfg.deviceFrame as "browser-chrome" | "macos-window" | "none",
    outputPath: session.outputPath,
    captureMethod: "none",
  });

  // Replay all stored events
  for (const evt of session.events) {
    manager.event(tempId, evt.type as import("../types.js").AgentEventType, evt.x, evt.y, {
      text: evt.meta?.text as string | undefined,
      url: evt.meta?.url as string | undefined,
      direction: evt.meta?.direction as string | undefined,
      elementRect: evt.meta?.elementRect as { x: number; y: number; width: number; height: number } | undefined,
    });
  }

  // Replay chapters
  for (const ch of session.chapters) {
    manager.chapter(tempId, ch.title);
  }

  // Stop generates timeline + runs ffmpeg post-processing
  const result = await manager.stop(tempId, {
    addWatermark: typeof flags.watermark === "string",
    watermarkText: typeof flags.watermark === "string" ? flags.watermark : undefined,
  });

  const endTime = Date.now();
  session.status = "done";
  session.endTime = endTime;
  saveState(state);

  output({
    session_id: sessionId,
    status: "done",
    output_path: result.outputPath,
    duration_s: result.duration,
    event_count: session.events.length,
    chapter_count: session.chapters.length,
  });
}

function cmdList(): void {
  const state = loadState();
  const sessions = Object.entries(state.sessions).map(([id, s]) => {
    const endTime = s.endTime ?? Date.now();
    return {
      session_id: id,
      status: s.status,
      duration_s: Math.round((endTime - s.startTime) / 1000),
      event_count: s.events.length,
      chapter_count: s.chapters.length,
    };
  });

  output({
    count: sessions.length,
    sessions,
  });
}

function cmdHelp(): void {
  console.log(`screen-studio — Screen Studio-style recording for AI agents

Commands:
  start     Start a new recording session
  event     Log a browser action (click, type, scroll, navigate, drag)
  chapter   Add a chapter marker
  status    Get session status
  stop      Stop recording and produce MP4
  list      List all sessions
  version   Show version

Examples:
  screen-studio start
  screen-studio start --output demo.mp4
  screen-studio start --device-frame browser-chrome --fps 60

  screen-studio event rec_abc123 --type click --x 500 --y 300
  screen-studio event rec_abc123 --type type --x 500 --y 320 --text "hello"
  screen-studio event rec_abc123 --type scroll --x 960 --y 540 --direction down
  screen-studio event rec_abc123 --type navigate --x 960 --y 540 --url https://example.com

  screen-studio chapter rec_abc123 --title "Login flow"

  screen-studio status rec_abc123
  screen-studio stop rec_abc123
  screen-studio stop rec_abc123 --watermark "Built with Deus"

  screen-studio list

Flags (start):
  --output <path>         Output MP4 path (default: /tmp/recording-{id}.mp4)
  --display <display>     X11 display for x11grab (default: :99)
  --fps <n>               Frame rate 1-120 (default: 30)
  --source-width <n>      Source width (default: 1920)
  --source-height <n>     Source height (default: 1080)
  --output-width <n>      Output width (default: 1920)
  --output-height <n>     Output height (default: 1080)
  --device-frame <type>   browser-chrome | macos-window | none (default: none)

Flags (event):
  --type <type>           click | type | scroll | navigate | screenshot | idle | drag (required)
  --x <n>                 X coordinate in source pixels (required)
  --y <n>                 Y coordinate in source pixels (required)
  --text <text>           Text for type events
  --url <url>             URL for navigate events
  --direction <dir>       up | down | left | right for scroll events
  --element-rect <json>   Element bounding box as JSON

Flags (stop):
  --watermark <text>      Add watermark text to bottom-right`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { command, positional, flags } = parseArgs(process.argv);

  if (flags.help || command === "help" || command === "--help" || command === "-h") {
    cmdHelp();
    return;
  }

  if (command === "version" || command === "--version" || command === "-v") {
    output({ version: "0.1.0" });
    return;
  }

  switch (command) {
    case "start":
      await cmdStart(flags);
      break;
    case "event":
      cmdEvent(positional, flags);
      break;
    case "chapter":
      cmdChapter(positional, flags);
      break;
    case "status":
      cmdStatus(positional);
      break;
    case "stop":
      await cmdStop(positional, flags);
      break;
    case "list":
      cmdList();
      break;
    default:
      error(
        `Unknown command: '${command}'`,
        "Available commands: start, event, chapter, status, stop, list. Run 'screen-studio --help' for usage.",
      );
  }
}

main().catch((err) => {
  error(err instanceof Error ? err.message : String(err));
});
