import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { newId } from "../bundle/bundle.js";
import { createAgentTools } from "../agent-tools.js";
import type { Manifest } from "../bundle/schema.js";
import { listSources } from "../capture/sources.js";
import { PRESETS } from "../direct/presets.js";
import { toErrorInfo } from "../errors.js";
import { inspectBundle } from "../render/inspect.js";
import { renderBundle, type RenderOptions, type RenderResult } from "../render/render.js";

const RenderFields = {
  preset: z
    .enum(Object.keys(PRESETS) as [string, ...string[]])
    .optional()
    .describe("walkthrough (default), demo, replay, or review"),
  pacing: z.enum(["preserve", "compress", "cut"]).optional(),
  targetDurationSeconds: z
    .number()
    .positive()
    .optional()
    .describe("Desired length; reported as unmet rather than cutting actions"),
  name: z
    .string()
    .regex(/^[\w.-]+$/)
    .optional(),
  cursor: z.enum(["auto", "cua", "arrow", "touch", "none"]).optional(),
  frame: z.enum(["auto", "browser", "window", "device", "rounded", "none"]).optional(),
  background: z
    .string()
    .optional()
    .describe("midnight, dusk, paper, black, none, '#hex' or '#from,#to'"),
  zoom: z.boolean().optional(),
  title: z.string().max(200).optional(),
};

function renderOptions(args: {
  preset?: string;
  pacing?: "preserve" | "compress" | "cut";
  targetDurationSeconds?: number;
  name?: string;
  cursor?: RenderOptions["cursor"];
  frame?: RenderOptions["frame"];
  background?: string;
  zoom?: boolean;
  title?: string;
}): RenderOptions {
  return {
    ...(args.preset ? { preset: args.preset } : {}),
    ...(args.pacing ? { pacing: args.pacing } : {}),
    ...(args.targetDurationSeconds ? { targetDurationMs: args.targetDurationSeconds * 1000 } : {}),
    ...(args.name ? { name: args.name } : {}),
    ...(args.cursor ? { cursor: args.cursor } : {}),
    ...(args.frame ? { frame: args.frame } : {}),
    ...(args.background ? { background: args.background } : {}),
    ...(args.zoom !== undefined ? { zoom: args.zoom } : {}),
    ...(args.title ? { title: args.title } : {}),
  };
}

function manifestSummary(dir: string, m: Manifest) {
  return {
    recordingId: m.id,
    bundle: dir,
    status: m.status,
    source: m.source.label,
    ...(m.capture.stopReason ? { stopReason: m.capture.stopReason } : {}),
    ...(m.media
      ? {
          media: {
            path: join(dir, m.media.path),
            durationMs: m.media.durationMs,
            width: m.media.width,
            height: m.media.height,
          },
        }
      : {}),
    ...(m.capture.warnings.length ? { warnings: m.capture.warnings } : {}),
    ...(m.capture.error ? { error: m.capture.error } : {}),
  };
}

function renderSummary(r: RenderResult) {
  return {
    video: r.outputPath,
    plan: r.planPath,
    ...(r.posterPath ? { poster: r.posterPath } : {}),
    durationSeconds: Math.round(r.durationMs) / 1000,
    sourceDurationSeconds: Math.round(r.sourceDurationMs) / 1000,
    chapters: r.chapters.map((c) => ({ title: c.title, time: c.startMs / 1000 })),
    ...(r.targetMet !== undefined ? { targetMet: r.targetMet } : {}),
    ...(r.warnings.length ? { warnings: r.warnings } : {}),
  };
}

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };
type ToolResult = { content: ToolContent[]; isError?: boolean };
type Shape = Record<string, z.ZodTypeAny>;

/**
 * registerTool's generic signature (it accepts zod 3 and 4 schemas) makes the
 * compiler instantiate enormous types per call — minutes of type checking and
 * an out-of-memory declaration build. Register through an erased signature and
 * keep handler arguments typed with plain zod inference instead.
 */
function register<S extends Shape>(
  server: McpServer,
  name: string,
  config: {
    title: string;
    description: string;
    inputSchema: S;
    annotations?: Record<string, boolean>;
  },
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<ToolResult>
): void {
  const registerTool = server.registerTool as unknown as (
    name: string,
    config: unknown,
    callback: (args: unknown) => Promise<ToolResult>
  ) => void;
  registerTool.call(server, name, config, (args) => handler(args as z.infer<z.ZodObject<S>>));
}

const ok = (value: unknown): ToolResult => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});
const fail = (err: unknown): ToolResult => ({
  content: [{ type: "text" as const, text: JSON.stringify({ error: toErrorInfo(err) }, null, 2) }],
  isError: true,
});

/** An MCP server whose process owns the recordings it starts. */
export function createMcpServer(options: { recordingsDir?: string } = {}): {
  server: McpServer;
  shutdown: () => Promise<void>;
} {
  const server = new McpServer({ name: "screen-studio", version: "0.2.0" });
  const recordingsDir = options.recordingsDir ?? join(tmpdir(), "screen-studio");

  // The same recording tools Deus and other hosts expose; this server lets the
  // agent name any source, and adds tools for re-rendering and inspecting.
  const agent = createAgentTools(
    {
      async resolveSource({ target, source }) {
        if (source) return source;
        if (target === "simulator") return "ios-simulator:booted";
        return process.env.SCREEN_STUDIO_BROWSER ?? "browser:http://127.0.0.1:9222";
      },
      bundleDir: () => join(recordingsDir, newId("rec")),
    },
    {
      allowSourceIds: true,
      actionTool: true,
      defaultMaxSeconds: 600,
      startDescription:
        "Start recording a source into a new bundle; returns once video is flowing. `source` takes an ID from " +
        "screen_studio_sources (agent-browser:<session>, browser:<devtools endpoint>, ios-simulator:booted, " +
        "display:0); without it, target browser records the Chrome at 127.0.0.1:9222 and simulator the booted one. " +
        "Browser actions are captured from the page itself; for other sources report them with recording_action. " +
        "Mark sections with recording_chapter; stop with recording_stop.",
    }
  );
  for (const tool of agent.tools) {
    register(
      server,
      tool.name,
      {
        title: tool.name.replace(/_/g, " "),
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { openWorldHint: false, ...tool.annotations },
      },
      tool.handler
    );
  }

  register(
    server,
    "screen_studio_sources",
    {
      title: "List recordable sources",
      description:
        "List browser tabs, booted iOS simulators and displays that can be recorded, with the source IDs recording_start accepts. Pass `cdp` to look at a specific DevTools endpoint.",
      inputSchema: { cdp: z.array(z.string()).optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        return ok(await listSources({ cdp: args.cdp }));
      } catch (err) {
        return fail(err);
      }
    }
  );

  register(
    server,
    "recording_render",
    {
      title: "Render a recording",
      description:
        "Render a finalized bundle again with different pacing or styling. Set plan to true to get the edit (kept/sped/cut segments, chapters, camera shots and their reasons) without rendering.",
      inputSchema: { bundle: z.string().min(1), plan: z.boolean().optional(), ...RenderFields },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        const result = await renderBundle(resolve(args.bundle), {
          ...renderOptions(args),
          planOnly: args.plan === true,
        });
        return ok(
          args.plan
            ? {
                plan: result.planPath,
                pacing: result.plan.pacing,
                chapters: result.chapters,
                camera: result.plan.camera,
                warnings: result.warnings,
              }
            : renderSummary(result)
        );
      } catch (err) {
        return fail(err);
      }
    }
  );

  register(
    server,
    "recording_inspect",
    {
      title: "Inspect a recording",
      description:
        "Facts, events and renders of a bundle. With contactSheet, also returns a grid of evenly spaced frames so you can check what was captured (or a render, with render).",
      inputSchema: {
        bundle: z.string().min(1),
        contactSheet: z.boolean().optional(),
        render: z.string().optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const result = await inspectBundle(resolve(args.bundle), {
          contactSheet: args.contactSheet,
          render: args.render,
        });
        const content: ToolContent[] = [
          {
            type: "text",
            text: JSON.stringify(
              {
                ...manifestSummary(result.dir, result.manifest),
                events: result.events,
                chapters: result.chapters,
                renders: result.renders,
                contactSheet: result.contactSheet,
              },
              null,
              2
            ),
          },
        ];
        if (result.contactSheet) {
          content.push({
            type: "image",
            data: (await readFile(result.contactSheet)).toString("base64"),
            mimeType: "image/png",
          });
        }
        return { content };
      } catch (err) {
        return fail(err);
      }
    }
  );

  return { server, shutdown: () => agent.dispose() };
}
