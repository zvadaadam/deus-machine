// agent-server/agents/deus-tools/recording.ts
// Recording tools for the Deus MCP server.
// Uses SessionManager from @deus/screen-studio as a library (Level 2 integration)
// instead of spawning a separate MCP server process.
//
// The agent sees: recording_start, recording_stop, recording_chapter, recording_status.
// recording_event is NOT exposed — events are captured automatically by the
// RecordingBridge which snoops on browser tool executions.

import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { SessionManager } from "../../../../packages/screen-studio/src/mcp/session-manager";
import type { AgentEventType } from "../../../../packages/screen-studio/src/types";

// Module-level SessionManager instance — shared across all recording tools
// and the RecordingBridge for a given agent-server process.
const sessionManager = new SessionManager();

/** Returns the shared SessionManager so the RecordingBridge can access it. */
export function getSessionManager(): SessionManager {
  return sessionManager;
}

// ============================================================================
// Zod schemas (adapted from packages/screen-studio/src/mcp/server.ts)
// ============================================================================

const GradientBackgroundSchema = z.object({
  type: z.literal("gradient"),
  colors: z
    .tuple([z.string(), z.string()])
    .describe("Two hex colors (e.g. ['#0f0f23', '#1a1a3e'])"),
  angle: z.number().min(0).max(360).optional().describe("Gradient angle in degrees. Default: 135"),
});

const SolidBackgroundSchema = z.object({
  type: z.literal("solid"),
  colors: z
    .tuple([z.string(), z.string()])
    .describe("Single color repeated (e.g. ['#1a1a2e', '#1a1a2e'])"),
});

const BackgroundSchema = z.discriminatedUnion("type", [
  GradientBackgroundSchema,
  SolidBackgroundSchema,
]);

/**
 * Creates the recording tool definitions for the Deus MCP server.
 * Returns an array of SdkMcpToolDefinition objects compatible with the
 * Claude Agent SDK's createSdkMcpServer.
 */
export function createRecordingTools(_sessionId: string): SdkMcpToolDefinition<any>[] {
  return [
    // ====================================================================
    // recording_start
    // ====================================================================
    tool(
      "recording_start",
      `Start a new screen recording session with cinematic camera engine.

The camera engine uses spring physics to produce smooth auto-zoom and panning
based on your browser actions (clicks, typing, scrolling). Events are captured
automatically from browser tools — you don't need to call recording_event.

Capture methods:
- "auto" (recommended): tries stream capture first, then avfoundation on macOS, falls back to events-only
- "stream": WebSocket stream from agent-browser, 10fps, no permission needed
- "avfoundation": macOS native 30fps (needs Screen Recording permission in System Settings)
- "none": events-only mode (no video capture, just camera timeline)

Returns a sessionId to use with recording_stop and recording_chapter.`,
      {
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
          "Background behind the device frame. Default: gradient #0f0f23 -> #1a1a3e"
        ),
        captureMethod: z
          .enum(["avfoundation", "cdp", "stream", "auto", "x11grab", "none"])
          .optional()
          .describe(
            "Screen capture method. 'auto' (recommended) tries stream then avfoundation. Default: 'none'"
          ),
        display: z
          .string()
          .optional()
          .describe("X11 display for x11grab capture (e.g. ':99'). Default: ':99'"),
      },
      async (args) => {
        console.log(`[recording] recording_start invoked`);
        try {
          const recordingSessionId = await sessionManager.create(args);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  sessionId: recordingSessionId,
                  status: "recording",
                }),
              },
            ],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text", text: `Error starting recording: ${message}` }],
          };
        }
      }
    ),

    // ====================================================================
    // recording_stop
    // ====================================================================
    tool(
      "recording_stop",
      `Stop a recording session and produce the final MP4.

Pipeline:
1. Stops screen capture (if running)
2. Computes camera timeline from recorded events (spring physics zoom/pan)
3. Applies zoompan/crop filter to raw capture -> final MP4
4. Cleans up temp files and returns the output path

Returns: { outputPath, duration, eventCount, chapterCount }`,
      {
        sessionId: z
          .string()
          .min(1)
          .describe("Session ID returned by recording_start (e.g. 'rec_a1b2c3')"),
        addWatermark: z.boolean().optional().describe("Add text watermark to bottom-right corner"),
        watermarkText: z
          .string()
          .max(200)
          .optional()
          .describe("Watermark text content (required when addWatermark is true)"),
      },
      async (args) => {
        console.log(`[recording] recording_stop invoked for session ${args.sessionId}`);
        try {
          if (args.addWatermark && (!args.watermarkText || args.watermarkText.length === 0)) {
            return {
              content: [
                {
                  type: "text",
                  text: "Error: watermarkText is required when addWatermark is true",
                },
              ],
            };
          }
          const result = await sessionManager.stop(args.sessionId, {
            addWatermark: args.addWatermark,
            watermarkText: args.watermarkText,
          });
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text", text: `Error stopping recording: ${message}` }],
          };
        }
      }
    ),

    // ====================================================================
    // recording_chapter
    // ====================================================================
    tool(
      "recording_chapter",
      `Add a chapter marker at the current point in the recording.
Chapters act as navigation bookmarks in the final video.

Returns: { chapterIndex, timestamp }`,
      {
        sessionId: z.string().min(1).describe("Session ID returned by recording_start"),
        title: z
          .string()
          .min(1)
          .max(200)
          .describe("Chapter title for navigation in the final video"),
      },
      async (args) => {
        console.log(
          `[recording] recording_chapter invoked for session ${args.sessionId}: "${args.title}"`
        );
        try {
          const result = sessionManager.chapter(args.sessionId, args.title);
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text", text: `Error adding chapter: ${message}` }],
          };
        }
      }
    ),

    // ====================================================================
    // recording_status
    // ====================================================================
    tool(
      "recording_status",
      `Get the current status and metadata of a recording session.
Returns: { status, duration, eventCount, chapterCount, outputPath? }`,
      {
        sessionId: z.string().min(1).describe("Session ID returned by recording_start"),
      },
      async (args) => {
        console.log(`[recording] recording_status invoked for session ${args.sessionId}`);
        try {
          const result = sessionManager.status(args.sessionId);
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text", text: `Error getting status: ${message}` }],
          };
        }
      }
    ),
  ];
}

// Re-export the AgentEventType for use by the recording bridge
export type { AgentEventType };
