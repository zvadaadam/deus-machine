import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SessionManager } from "./session-manager.js";

// ---------------------------------------------------------------------------
// Shared Zod schemas
// ---------------------------------------------------------------------------

const SessionIdSchema = z
  .string()
  .min(1, "sessionId is required")
  .describe("Session ID returned by recording_start (e.g. 'rec_a1b2c3')");

const GradientBackgroundSchema = z
  .object({
    type: z.literal("gradient"),
    colors: z
      .tuple([z.string(), z.string()])
      .describe("Two hex colors (e.g. ['#0f0f23', '#1a1a3e'])"),
    angle: z
      .number()
      .min(0)
      .max(360)
      .optional()
      .describe("Gradient angle in degrees. Default: 135"),
  })
  .strict();

const SolidBackgroundSchema = z
  .object({
    type: z.literal("solid"),
    colors: z
      .tuple([z.string(), z.string()])
      .describe("Single color repeated (e.g. ['#1a1a2e', '#1a1a2e'])"),
  })
  .strict();

const BackgroundSchema = z.discriminatedUnion("type", [
  GradientBackgroundSchema,
  SolidBackgroundSchema,
]);

const ElementRectSchema = z
  .object({
    x: z.number().describe("Left edge in source pixels"),
    y: z.number().describe("Top edge in source pixels"),
    width: z.number().positive().describe("Element width in pixels"),
    height: z.number().positive().describe("Element height in pixels"),
  })
  .strict();

// ---------------------------------------------------------------------------
// Tool input schemas
// ---------------------------------------------------------------------------

const RecordingStartInputSchema = z
  .object({
    outputPath: z
      .string()
      .optional()
      .describe("Where to write the final MP4. Default: /tmp/recording-{timestamp}.mp4"),
    sourceWidth: z
      .number()
      .int()
      .positive()
      .max(7680)
      .optional()
      .describe("Source capture width in pixels. Default: 1920"),
    sourceHeight: z
      .number()
      .int()
      .positive()
      .max(4320)
      .optional()
      .describe("Source capture height in pixels. Default: 1080"),
    outputWidth: z
      .number()
      .int()
      .positive()
      .max(7680)
      .optional()
      .describe("Output video width in pixels. Default: 1920"),
    outputHeight: z
      .number()
      .int()
      .positive()
      .max(4320)
      .optional()
      .describe("Output video height in pixels. Default: 1080"),
    fps: z.number().int().min(1).max(120).optional().describe("Frame rate. Default: 30"),
    deviceFrame: z
      .enum(["browser-chrome", "macos-window", "none"])
      .optional()
      .describe("Device frame overlay style. Default: 'none'"),
    background: BackgroundSchema.optional().describe(
      "Background behind the device frame. Default: gradient #0f0f23 → #1a1a3e"
    ),
    captureMethod: z
      .enum(["avfoundation", "cdp", "stream", "auto", "x11grab", "none"])
      .optional()
      .describe(
        "Screen capture method. 'auto' = best available (stream → avfoundation → none). " +
          "'stream' = WebSocket stream from agent-browser, 10fps, no permission needed. " +
          "'avfoundation' = macOS 30fps (needs Screen Recording permission). " +
          "'cdp' = CDP screenshots piped to ffmpeg, 10fps, no permission needed. " +
          "'x11grab' = Linux/Xvfb. 'none' = events-only. Default: 'none'"
      ),
    display: z
      .string()
      .optional()
      .describe("X11 display for x11grab capture (e.g. ':99'). Default: ':99'"),
  })
  .strict();

const RecordingStopInputSchema = z
  .object({
    sessionId: SessionIdSchema,
    addWatermark: z
      .boolean()
      .optional()
      .default(false)
      .describe("Add text watermark to bottom-right corner"),
    watermarkText: z
      .string()
      .max(200)
      .optional()
      .describe("Watermark text content (required when addWatermark is true)"),
  })
  .strict();

const RecordingEventInputSchema = z
  .object({
    sessionId: SessionIdSchema,
    type: z
      .enum(["click", "type", "scroll", "navigate", "screenshot", "idle", "drag"])
      .describe("Agent action type"),
    x: z.number().min(0).describe("X coordinate of the action in source pixels"),
    y: z.number().min(0).describe("Y coordinate of the action in source pixels"),
    elementRect: ElementRectSchema.optional().describe(
      "Bounding box of the interacted element. Helps camera frame the element precisely."
    ),
    text: z.string().optional().describe("Text content for 'type' events"),
    url: z.string().optional().describe("URL for 'navigate' events"),
    direction: z
      .enum(["up", "down", "left", "right"])
      .optional()
      .describe("Scroll direction for 'scroll' events"),
  })
  .strict();

const RecordingChapterInputSchema = z
  .object({
    sessionId: SessionIdSchema,
    title: z
      .string()
      .min(1, "Chapter title is required")
      .max(200)
      .describe("Chapter title for navigation in the final video"),
  })
  .strict();

const RecordingStatusInputSchema = z
  .object({
    sessionId: SessionIdSchema,
  })
  .strict();

// ---------------------------------------------------------------------------
// Tool output schemas
// ---------------------------------------------------------------------------

const RecordingStartOutputSchema = z.object({
  sessionId: z.string().describe("Session ID to use with other recording tools"),
  status: z.literal("recording"),
});

const RecordingStopOutputSchema = z.object({
  outputPath: z.string().describe("Path to the final MP4 file"),
  duration: z.number().describe("Recording duration in seconds"),
  eventCount: z.number().describe("Total agent events recorded"),
  chapterCount: z.number().describe("Total chapters added"),
});

const RecordingEventOutputSchema = z.object({
  recorded: z.literal(true),
  eventIndex: z.number().describe("Index of this event in the session timeline"),
});

const RecordingChapterOutputSchema = z.object({
  chapterIndex: z.number().describe("Index of this chapter"),
  timestamp: z.number().describe("Timestamp in milliseconds from session start"),
});

const RecordingStatusOutputSchema = z.object({
  status: z.enum(["recording", "processing", "done", "error"]),
  duration: z.number().describe("Elapsed time in seconds"),
  eventCount: z.number(),
  chapterCount: z.number(),
  outputPath: z.string().optional().describe("Output path (present when status is 'done')"),
});

// ---------------------------------------------------------------------------
// Error helper
// ---------------------------------------------------------------------------

function toolError(err: unknown): { content: [{ type: "text"; text: string }]; isError: true } {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

/**
 * Create and configure the Screen Studio MCP server.
 *
 * Uses the modern `registerTool` API with full annotations, output schemas,
 * and structured content per MCP best practices.
 */
export function createMcpServer(): { server: McpServer; sessionManager: SessionManager } {
  const server = new McpServer({
    name: "screen-studio-mcp-server",
    version: "0.1.0",
  });

  const sessionManager = new SessionManager();

  // -----------------------------------------------------------------------
  // recording_start
  // -----------------------------------------------------------------------
  server.registerTool(
    "recording_start",
    {
      title: "Start Screen Recording",
      description: `Start a new screen recording session with Screen Studio-style camera engine.

The camera engine uses spring physics to produce smooth auto-zoom and panning
based on agent actions (clicks, typing, scrolling). Optionally captures screen
frames via ffmpeg for post-processing into a polished MP4.

Args:
  - outputPath (string, optional): Final MP4 path. Default: /tmp/recording-{timestamp}.mp4
  - sourceWidth/sourceHeight (int, optional): Source resolution. Default: 1920x1080
  - outputWidth/outputHeight (int, optional): Output resolution. Default: 1920x1080
  - fps (int, optional): Frame rate 1-120. Default: 30
  - deviceFrame ('browser-chrome' | 'macos-window' | 'none'): Device frame overlay
  - background (object, optional): Background behind device frame
  - captureMethod ('x11grab' | 'avfoundation' | 'screenshot' | 'none'): Capture mode
  - display (string, optional): X11 display for x11grab. Default: ':99'

Returns:
  { "sessionId": "rec_a1b2c3", "status": "recording" }

Examples:
  - Events-only mode: { } (all defaults, no screen capture)
  - Linux VM capture: { "captureMethod": "x11grab", "display": ":99" }
  - macOS capture: { "captureMethod": "avfoundation" }
  - Custom output: { "outputPath": "/tmp/demo.mp4", "deviceFrame": "browser-chrome" }

Error Handling:
  - "ffmpeg is not available" → Install ffmpeg or use captureMethod: 'none'
  - Session creation errors include actionable suggestions`,
      inputSchema: RecordingStartInputSchema,
      outputSchema: RecordingStartOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params) => {
      try {
        const sessionId = await sessionManager.create(params);
        const output = { sessionId, status: "recording" as const };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(output) }],
          structuredContent: { ...output },
        };
      } catch (err) {
        return toolError(err);
      }
    }
  );

  // -----------------------------------------------------------------------
  // recording_stop
  // -----------------------------------------------------------------------
  server.registerTool(
    "recording_stop",
    {
      title: "Stop Screen Recording",
      description: `Stop a recording session and produce the final MP4.

Pipeline:
1. Stops ffmpeg screen capture (if running)
2. Computes camera timeline from recorded events (spring physics zoom/pan)
3. Generates ffmpeg zoompan filter from the timeline
4. Runs post-processing: raw video + filter → composited MP4
5. Cleans up temp files and returns the output path

Args:
  - sessionId (string, required): Session ID from recording_start
  - addWatermark (boolean, optional): Add text watermark to bottom-right
  - watermarkText (string, optional): Watermark text (required if addWatermark is true)

Returns:
  {
    "outputPath": "/tmp/recording-rec_a1b2c3.mp4",
    "duration": 12.5,
    "eventCount": 15,
    "chapterCount": 3
  }

Error Handling:
  - "Session not found" → Check the sessionId from recording_start
  - "Session is not recording" → Session was already stopped or errored
  - "ffmpeg post-processing exited" → Check ffmpeg stderr in the error message`,
      inputSchema: RecordingStopInputSchema,
      outputSchema: RecordingStopOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params) => {
      try {
        if (params.addWatermark && (!params.watermarkText || params.watermarkText.length === 0)) {
          return toolError(new Error("watermarkText is required when addWatermark is true"));
        }
        const result = await sessionManager.stop(params.sessionId, {
          addWatermark: params.addWatermark,
          watermarkText: params.watermarkText,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: { ...result },
        };
      } catch (err) {
        return toolError(err);
      }
    }
  );

  // -----------------------------------------------------------------------
  // recording_event
  // -----------------------------------------------------------------------
  server.registerTool(
    "recording_event",
    {
      title: "Log Recording Event",
      description: `Log a browser action event that drives the camera's auto-zoom and panning.

Each event tells the camera engine where to look. The engine uses spring physics
to smoothly animate between targets. Events are timestamped automatically.

Event types and their camera behavior:
  - 'click': Camera zooms to 1.8x on the clicked element
  - 'type': Camera zooms to 2.0x on the text input field
  - 'scroll': Camera zooms out to 1.3x for context
  - 'navigate': Camera resets to 1.0x (full viewport)
  - 'screenshot': Camera holds position at 1.0x
  - 'idle': Camera gently zooms out to 1.0x

Args:
  - sessionId (string, required): Session ID from recording_start
  - type (string, required): One of 'click', 'type', 'scroll', 'navigate', 'screenshot', 'idle'
  - x (number, required): X coordinate of the action in source pixels
  - y (number, required): Y coordinate of the action in source pixels
  - elementRect (object, optional): Bounding box of the target element { x, y, width, height }
  - text (string, optional): Text content for 'type' events
  - url (string, optional): URL for 'navigate' events
  - direction (string, optional): 'up' | 'down' | 'left' | 'right' for scroll events

Returns:
  { "recorded": true, "eventIndex": 5 }

Examples:
  - Click: { "sessionId": "rec_abc", "type": "click", "x": 500, "y": 300 }
  - Type: { "sessionId": "rec_abc", "type": "type", "x": 500, "y": 320, "text": "hello" }
  - Scroll: { "sessionId": "rec_abc", "type": "scroll", "x": 960, "y": 540, "direction": "down" }

Error Handling:
  - "Session not found" → Check the sessionId from recording_start
  - "Session is not recording" → Session was already stopped`,
      inputSchema: RecordingEventInputSchema,
      outputSchema: RecordingEventOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params) => {
      try {
        const eventIndex = sessionManager.event(params.sessionId, params.type, params.x, params.y, {
          elementRect: params.elementRect,
          text: params.text,
          url: params.url,
          direction: params.direction,
        });
        const output = { recorded: true as const, eventIndex };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(output) }],
          structuredContent: { ...output },
        };
      } catch (err) {
        return toolError(err);
      }
    }
  );

  // -----------------------------------------------------------------------
  // recording_chapter
  // -----------------------------------------------------------------------
  server.registerTool(
    "recording_chapter",
    {
      title: "Add Recording Chapter",
      description: `Add a chapter marker at the current point in the recording.

Chapters act as navigation bookmarks in the final video. They are timestamped
relative to the session start and associated with the current event index.

Args:
  - sessionId (string, required): Session ID from recording_start
  - title (string, required): Chapter title (1-200 chars)

Returns:
  { "chapterIndex": 2, "timestamp": 15000 }

Examples:
  - { "sessionId": "rec_abc", "title": "Navigate to login page" }
  - { "sessionId": "rec_abc", "title": "Fill in credentials" }

Error Handling:
  - "Session not found" → Check the sessionId from recording_start
  - "Session is not recording" → Session was already stopped`,
      inputSchema: RecordingChapterInputSchema,
      outputSchema: RecordingChapterOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params) => {
      try {
        const result = sessionManager.chapter(params.sessionId, params.title);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: { ...result },
        };
      } catch (err) {
        return toolError(err);
      }
    }
  );

  // -----------------------------------------------------------------------
  // recording_status
  // -----------------------------------------------------------------------
  server.registerTool(
    "recording_status",
    {
      title: "Get Recording Status",
      description: `Get the current status and metadata of a recording session.

Use this to check whether a session is still recording, processing the final
video, done, or errored. Also returns event and chapter counts.

Args:
  - sessionId (string, required): Session ID from recording_start

Returns:
  {
    "status": "recording",
    "duration": 12.5,
    "eventCount": 15,
    "chapterCount": 3,
    "outputPath": "/tmp/recording.mp4"  // only present when status is 'done'
  }

Error Handling:
  - "Session not found" → Check the sessionId from recording_start`,
      inputSchema: RecordingStatusInputSchema,
      outputSchema: RecordingStatusOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      try {
        const result = sessionManager.status(params.sessionId);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: { ...result },
        };
      } catch (err) {
        return toolError(err);
      }
    }
  );

  return { server, sessionManager };
}
