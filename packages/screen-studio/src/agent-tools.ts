/**
 * The recording tools an agent sees, defined once.
 *
 * Every host — Deus, AGNT, the standalone MCP server — exposes the same tools
 * with the same words. A host supplies only what is its own: what "record the
 * browser" means for this session, where bundles live, how an element ref
 * becomes a rectangle, and what to do when a recording starts or stops.
 * Definitions are framework-neutral (a zod shape and a handler), so a host
 * registers them with whatever MCP layer it uses.
 */
import { z } from "zod";
import type { Manifest, Rect } from "./bundle/schema.js";
import type { SourceSpec } from "./capture/sources.js";
import { toErrorInfo } from "./errors.js";
import { startRecording, type ActionInput, type Recording } from "./recorder.js";
import { renderBundle, type RenderResult } from "./render/render.js";

export type RecordTarget = "browser" | "simulator";

export interface AgentToolHost {
  /** What to record for this agent session. */
  resolveSource(request: {
    target: RecordTarget;
    destination?: string;
    /** An explicit source ID, when the host lets the agent choose. */
    source?: string;
  }): Promise<SourceSpec | string>;
  /** A new, empty bundle directory for a recording. */
  bundleDir(): string;
  /** Turn an element reference (e.g. "@e12" or a selector) into its box. */
  resolveRef?(ref: string): Promise<Rect | null>;
  /** Started, stopped or finished on its own (deadline, lost source). */
  onStateChange?(state: "recording" | "stopped", recording: Recording): void;
}

export interface AgentToolOptions {
  defaultMaxSeconds?: number;
  /** Let the agent pass an explicit source ID (standalone use). */
  allowSourceIds?: boolean;
  /** Offer `recording_action`, for sources that cannot observe actions themselves. */
  actionTool?: boolean;
  /** Text shown at start; hosts can describe their own targets. */
  startDescription?: string;
}

export interface AgentToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface AgentToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  handler: (args: Record<string, unknown>) => Promise<AgentToolResult>;
}

/** What `recording_stop` returns: the video and what is in it, times in seconds. */
export interface StopSummary {
  outputPath: string;
  thumbnailPath: string;
  duration: number;
  sourceDuration: number;
  chapters: Array<{ title: string; time: number }>;
  events: Array<{ type: string; time: number; text?: string; url?: string }>;
  eventCount: number;
  bundlePath: string;
  stopReason?: string;
  warnings?: string[];
}

export function stopSummary(dir: string, manifest: Manifest, render: RenderResult): StopSummary {
  return {
    outputPath: render.outputPath,
    thumbnailPath: render.posterPath ?? "",
    duration: Math.round(render.durationMs) / 1000,
    sourceDuration: Math.round(render.sourceDurationMs) / 1000,
    chapters: render.chapters.map((c) => ({ title: c.title, time: c.startMs / 1000 })),
    events: render.events.map((e) => ({
      type: e.type,
      time: e.timeMs / 1000,
      ...(e.label ? { text: e.label } : {}),
      ...(e.url ? { url: e.url } : {}),
    })),
    eventCount: render.events.length,
    bundlePath: dir,
    ...(manifest.capture.stopReason ? { stopReason: manifest.capture.stopReason } : {}),
    ...(render.warnings.length ? { warnings: render.warnings } : {}),
  };
}

const text = (value: unknown): AgentToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
});
const failure = (prefix: string, err: unknown): AgentToolResult => {
  const info = toErrorInfo(err);
  return {
    content: [
      {
        type: "text",
        text: `${prefix}: ${info.message}${info.hint ? `\nHint: ${info.hint}` : ""}`,
      },
    ],
    isError: true,
  };
};

const RectShape = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
});

const START = `Start recording a demo of your work. Open the page or app you want to show first, then use your normal tools: in a browser every click, keystroke and navigation is captured from the page itself, and the edit frames each action, finds the result that follows it, and speeds up or cuts the waiting. Mark sections with recording_chapter and finish with recording_stop. The recording stops itself after maxDurationSeconds.

Record a deliberate walkthrough after the work is done, not the whole investigation.`;

/**
 * One recording at a time per tool set: create a tool set per agent session.
 */
export function createAgentTools(host: AgentToolHost, options: AgentToolOptions = {}) {
  let current: Recording | null = null;
  /** A recording_start in progress, so dispose can cancel it. */
  let starting: { abort: AbortController; done: Promise<void> } | null = null;
  const maxDefault = options.defaultMaxSeconds ?? 300;

  const live = (): Recording => {
    if (!current) throw new Error("No recording in this session. Call recording_start first.");
    return current;
  };

  const tools: AgentToolDefinition[] = [
    {
      name: "recording_start",
      description: options.startDescription ?? START,
      inputSchema: {
        target: z
          .enum(["browser", "simulator"])
          .optional()
          .describe("What to record. Default: browser"),
        destination: z.string().optional().describe("Simulator name or UDID (simulator only)"),
        ...(options.allowSourceIds
          ? {
              source: z
                .string()
                .optional()
                .describe("Explicit source ID, e.g. ios-simulator:booted"),
            }
          : {}),
        maxDurationSeconds: z
          .number()
          .int()
          .min(5)
          .max(4 * 3600)
          .optional()
          .describe(`Hard limit. Default: ${maxDefault}`),
      },
      async handler(args) {
        if (current?.isRecording || starting) {
          return text(
            `Already recording${current?.isRecording ? ` (${current.id})` : ""}. Call recording_stop first.`
          );
        }
        const abort = new AbortController();
        let done!: () => void;
        starting = { abort, done: new Promise((resolve) => (done = resolve)) };
        try {
          const source = await host.resolveSource({
            target: (args.target as RecordTarget | undefined) ?? "browser",
            ...(typeof args.destination === "string" ? { destination: args.destination } : {}),
            ...(typeof args.source === "string" ? { source: args.source } : {}),
          });
          const seconds = (args.maxDurationSeconds as number | undefined) ?? maxDefault;
          const recording = await startRecording({
            source,
            out: host.bundleDir(),
            maxDurationMs: seconds * 1000,
            reporter: "agent",
            signal: abort.signal,
          });
          current = recording;
          host.onStateChange?.("recording", recording);
          void recording.finished.then(() => host.onStateChange?.("stopped", recording));
          return text({
            sessionId: recording.id,
            status: "recording",
            source: recording.manifest.source.label,
            stopsAutomaticallyAfterSeconds: seconds,
          });
        } catch (err) {
          return failure("Error starting recording", err);
        } finally {
          starting = null;
          done();
        }
      },
    },
    {
      name: "recording_chapter",
      description: `Mark the start of a section ("Sign in", "Create a project"). Chapters stay attached to their moment when waiting is cut, and appear as chapters in the video.`,
      inputSchema: { title: z.string().min(1).max(200) },
      async handler(args) {
        try {
          const event = await live().chapter(String(args.title));
          return text({ chapterId: event.id, title: event.title });
        } catch (err) {
          return failure("Error adding chapter", err);
        }
      },
    },
    {
      name: "recording_focus",
      description: `Point the camera at something specific. Results that appear after an action (a confirmation, a generated preview) are found and framed automatically; use this when the video should show something else.${host.resolveRef ? " Give an element ref from your latest snapshot, or a rect." : " Give a rect in the page's (or iOS points') coordinates."}`,
      inputSchema: {
        ...(host.resolveRef
          ? { ref: z.string().optional().describe("Element ref, e.g. @e12") }
          : {}),
        rect: RectShape.optional(),
        label: z.string().max(200).optional(),
        seconds: z
          .number()
          .positive()
          .max(30)
          .optional()
          .describe("How long to show it. Default: 2"),
      },
      async handler(args) {
        try {
          const recording = live();
          const ref = typeof args.ref === "string" ? args.ref : undefined;
          const rect =
            ref && host.resolveRef ? await host.resolveRef(ref) : (args.rect as Rect | undefined);
          if (!rect) return text(ref ? `Could not find ${ref}.` : "Pass a ref or a rect.");
          const event = await recording.focus(rect, {
            ...(typeof args.label === "string" ? { label: args.label } : {}),
            durationMs: ((args.seconds as number | undefined) ?? 2) * 1000,
          });
          return text({ focusId: event.id, rect });
        } catch (err) {
          return failure("Error adding focus", err);
        }
      },
    },
    {
      name: "recording_hold",
      description: "Keep the next moments at normal speed, e.g. while a result is worth reading.",
      inputSchema: {
        seconds: z.number().positive().max(30),
        reason: z.string().max(200).optional(),
      },
      async handler(args) {
        try {
          const event = await live().hold(
            Number(args.seconds) * 1000,
            args.reason as string | undefined
          );
          return text({ holdId: event.id });
        } catch (err) {
          return failure("Error adding hold", err);
        }
      },
    },
    ...(options.actionTool
      ? [
          {
            name: "recording_action",
            description:
              "Report an action the recording cannot see by itself (sources other than a browser). Coordinates in the source's viewport; report right after the action, with durationMs if it took a while.",
            inputSchema: {
              type: z.enum([
                "click",
                "tap",
                "type",
                "key",
                "scroll",
                "swipe",
                "navigate",
                "drag",
                "other",
              ]),
              rect: RectShape.optional(),
              x: z.number().optional(),
              y: z.number().optional(),
              durationMs: z.number().nonnegative().max(120_000).optional(),
              label: z.string().max(200).optional(),
            },
            async handler(args: Record<string, unknown>) {
              try {
                const now = Date.now();
                const event = await live().action({
                  type: args.type as ActionInput["type"],
                  at: now - ((args.durationMs as number | undefined) ?? 0),
                  endAt: now,
                  ...(args.rect ? { rect: args.rect as Rect } : {}),
                  ...(typeof args.x === "number" && typeof args.y === "number"
                    ? { point: { x: args.x, y: args.y } }
                    : {}),
                  ...(typeof args.label === "string" ? { label: args.label } : {}),
                });
                return text({ actionId: event.id });
              } catch (err) {
                return failure("Error recording action", err);
              }
            },
          } satisfies AgentToolDefinition,
        ]
      : []),
    {
      name: "recording_status",
      description:
        "Whether this session is recording, for how long, and when it stops automatically.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
      async handler() {
        try {
          const { manifest } = live();
          return text({
            sessionId: manifest.id,
            status: manifest.status,
            source: manifest.source.label,
            ...(manifest.status === "recording" && manifest.capture.startedAt
              ? { elapsedSeconds: Math.round((Date.now() - manifest.capture.startedAt) / 1000) }
              : {}),
            ...(manifest.capture.stopReason ? { stopReason: manifest.capture.stopReason } : {}),
          });
        } catch (err) {
          return failure("Error getting status", err);
        }
      },
    },
    {
      name: "recording_stop",
      description: `Stop recording and produce the video. The original capture is kept and can be re-edited.

Presets: "walkthrough" (default: waits sped up, gentle zoom), "demo" (waits cut, closer zoom, shortest), "replay" (waits sped up, no styling), "review" (original timing, no styling).

Returns: { outputPath, thumbnailPath, duration, chapters, events, bundlePath }`,
      inputSchema: {
        preset: z.enum(["walkthrough", "demo", "replay", "review"]).optional(),
        targetDurationSeconds: z
          .number()
          .positive()
          .optional()
          .describe("Desired length. Actions and their results are never cut to reach it."),
      },
      annotations: { idempotentHint: true },
      async handler(args) {
        try {
          const recording = live();
          const manifest = await recording.stop("requested");
          if (manifest.status !== "complete") {
            const error = manifest.capture.error;
            return {
              content: [
                {
                  type: "text",
                  text: `Recording failed: ${error?.message ?? "no media was captured"}${error?.hint ? `\nHint: ${error.hint}` : ""}`,
                },
              ],
              isError: true,
            };
          }
          const render = await renderBundle(recording.dir, {
            preset: (args.preset as string | undefined) ?? "walkthrough",
            ...(typeof args.targetDurationSeconds === "number"
              ? { targetDurationMs: args.targetDurationSeconds * 1000 }
              : {}),
          });
          return text(stopSummary(recording.dir, manifest, render));
        } catch (err) {
          return failure("Error stopping recording", err);
        }
      },
    },
  ];

  return {
    tools,
    /** The recording this tool set controls, if any. */
    current: (): Recording | null => current,
    /** For controllers that report their own actions (simulator taps). Never throws. */
    recordAction(action: ActionInput): void {
      if (!current?.isRecording) return;
      current.action(action).catch(() => {});
    },
    /** Stop whatever is recording, e.g. when the agent session ends. */
    async dispose(): Promise<void> {
      if (starting) {
        starting.abort.abort();
        await starting.done;
      }
      await current?.stop("signal");
    },
  };
}
