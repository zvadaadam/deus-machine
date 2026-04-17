// agent-server/agents/deus-tools/simulator.ts
//
// Built-in iOS Simulator MCP tools for the Deus MCP server.
// Replaces the external xcode-mcp dependency with in-process tools
// backed by device-use/engine.
//
// These tools run headlessly in the agent-server — no Electron, no frontend.
// The Simulator Panel is a separate visualization concern (backend-managed).
//
// Tool naming convention: SimulatorXxx (matches BrowserXxx pattern).

import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import * as SimOps from "./sim-ops";
import { getErrorMessage } from "@shared/lib/errors";

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function imageResult(base64: string, mimeType: string, caption?: string) {
  const parts: Array<{ type: string; [k: string]: unknown }> = [];
  if (caption) parts.push({ type: "text", text: caption });
  parts.push({ type: "image", data: base64, mimeType });
  return { content: parts };
}

/**
 * Wraps a tool handler with error catching. Returns error text instead
 * of throwing — same pattern as browser tools.
 */
function withSimulator<T>(
  fn: (args: T) => Promise<{ content: Array<{ type: string; [k: string]: unknown }> }>
) {
  return async (args: T) => {
    try {
      return await fn(args);
    } catch (err) {
      return textResult(`Simulator error: ${getErrorMessage(err)}`);
    }
  };
}

/**
 * Creates the simulator tool definitions for a given session.
 * Injected into the Deus MCP server alongside browser/workspace/recording tools.
 */
export function createSimulatorTools(sessionId: string): SdkMcpToolDefinition<any>[] {
  return [
    // -- ListDevices ----------------------------------------------------------
    tool(
      "SimulatorListDevices",
      `List all available iOS simulators. Returns each simulator's name, UDID, state (Booted/Shutdown), and runtime version. Use this to find a simulator to work with.`,
      {},
      withSimulator(async () => {
        const devices = await SimOps.listDevices();
        if (devices.length === 0) {
          return textResult(
            "No simulators found. Install simulators via Xcode > Settings > Platforms."
          );
        }
        const lines = devices.map(
          (d) => `${d.state === "Booted" ? "[BOOTED] " : ""}${d.name} (${d.runtime}) — ${d.udid}`
        );
        return textResult(`Found ${devices.length} simulator(s):\n${lines.join("\n")}`);
      })
    ),

    // -- Screenshot -----------------------------------------------------------
    tool(
      "SimulatorScreenshot",
      `Capture a screenshot of the running iOS simulator. Returns the image as base64. Use to see what the app looks like and identify UI elements before interacting.`,
      {
        destination: z
          .string()
          .optional()
          .describe("Simulator name or UDID (optional, uses active)"),
        format: z.enum(["png", "jpeg"]).optional().describe("Image format (default: jpeg)"),
      },
      withSimulator(async (args) => {
        const udid = await SimOps.resolveDevice(args.destination, sessionId);
        const format = args.format ?? "jpeg";
        const img = await SimOps.screenshot(udid, format);
        return imageResult(img.base64, img.mimeType, "Simulator screenshot captured.");
      })
    ),

    // -- Tap ------------------------------------------------------------------
    tool(
      "SimulatorTap",
      `Tap on the iOS simulator screen. Pass EXACTLY ONE of:
- 'ref': a @eN reference from the most recent SimulatorReadScreen output (preferred — most precise)
- 'identifier': the accessibilityIdentifier set in app code (e.g., 'SubmitButton')
- 'label': the iOS accessibility label (e.g., 'Submit'). Not placeholder text.
- 'x' + 'y': logical-point coordinates, origin top-left (last resort — fragile)

Prefer ref when you just ran ReadScreen; prefer identifier when you know the
app's code; fall back to label for system UI. Coordinates are unreliable
because layouts shift between reads.`,
      {
        ref: z
          .string()
          .optional()
          .describe("@eN reference from the most recent SimulatorReadScreen output (e.g., '@e3')"),
        identifier: z
          .string()
          .optional()
          .describe("accessibilityIdentifier from app code (e.g., 'SubmitButton', 'NameField')"),
        label: z
          .string()
          .optional()
          .describe("iOS accessibility label (e.g., 'Address' for Safari URL bar)"),
        x: z
          .number()
          .optional()
          .describe("X coordinate in iOS logical points (must also provide y)"),
        y: z
          .number()
          .optional()
          .describe("Y coordinate in iOS logical points (must also provide x)"),
        destination: z.string().optional().describe("Simulator name or UDID"),
        includeScreenshot: z
          .boolean()
          .optional()
          .describe("Include screenshot after tap (default: true)"),
      },
      withSimulator(async (args) => {
        const udid = await SimOps.resolveDevice(args.destination, sessionId);
        await SimOps.tap(udid, {
          ref: args.ref,
          identifier: args.identifier,
          label: args.label,
          x: args.x,
          y: args.y,
          sessionKey: sessionId,
        });

        const tapDesc = args.ref
          ? args.ref
          : args.identifier
            ? `#${args.identifier}`
            : args.label
              ? `"${args.label}"`
              : `(${args.x}, ${args.y})`;

        if (args.includeScreenshot === false) {
          return textResult(`Tapped ${tapDesc}. Use SimulatorScreenshot to see the result.`);
        }

        const img = await SimOps.screenshot(udid, "jpeg");
        return imageResult(img.base64, img.mimeType, `Tapped ${tapDesc}`);
      })
    ),

    // -- TypeText --------------------------------------------------------------
    tool(
      "SimulatorTypeText",
      `Type text into the currently focused field in the iOS simulator. Tap a text field first to focus it.

The screenshot returned may be captured BEFORE page loads / async side-effects
complete. Use SimulatorWaitFor(stabilize=true) afterward if you need the result.`,
      {
        text: z.string().describe("The text to type"),
        submit: z
          .boolean()
          .optional()
          .describe(
            "Send Return keypress after typing. For search fields this triggers submission, but the page may not have loaded when the response returns."
          ),
        destination: z.string().optional().describe("Simulator name or UDID"),
        includeScreenshot: z
          .boolean()
          .optional()
          .describe("Include screenshot after typing (default: true)"),
      },
      withSimulator(async (args) => {
        const udid = await SimOps.resolveDevice(args.destination, sessionId);
        await SimOps.typeText(udid, args.text, { submit: args.submit });

        const preview = args.text.length > 40 ? args.text.slice(0, 40) + "..." : args.text;

        if (args.includeScreenshot === false) {
          return textResult(`Typed "${preview}". Use SimulatorScreenshot to see the result.`);
        }

        const img = await SimOps.screenshot(udid, "jpeg");
        return imageResult(img.base64, img.mimeType, `Typed "${preview}"`);
      })
    ),

    // -- Swipe ----------------------------------------------------------------
    tool(
      "SimulatorSwipe",
      `Swipe on the iOS simulator. Use direction (up/down/left/right) for simple scrolling, or explicit start/end coordinates for precise control.

Direction semantics: "up" scrolls content down (finger moves up), "down" scrolls content up.`,
      {
        direction: z.enum(["up", "down", "left", "right"]).optional().describe("Swipe direction"),
        distance: z
          .number()
          .optional()
          .describe("Distance in points for direction-based swipe (default: 300)"),
        startX: z.number().optional().describe("Starting X coordinate in iOS points"),
        startY: z.number().optional().describe("Starting Y coordinate in iOS points"),
        endX: z.number().optional().describe("Ending X coordinate in iOS points"),
        endY: z.number().optional().describe("Ending Y coordinate in iOS points"),
        duration: z.number().optional().describe("Swipe duration in milliseconds (default: 300)"),
        destination: z.string().optional().describe("Simulator name or UDID"),
        includeScreenshot: z
          .boolean()
          .optional()
          .describe("Include screenshot after swipe (default: true)"),
      },
      withSimulator(async (args) => {
        const udid = await SimOps.resolveDevice(args.destination, sessionId);
        await SimOps.swipe(udid, args);

        const label = args.direction ?? "custom";

        if (args.includeScreenshot === false) {
          return textResult(`Swiped ${label}. Use SimulatorScreenshot to see the result.`);
        }

        const img = await SimOps.screenshot(udid, "jpeg");
        return imageResult(img.base64, img.mimeType, `Swiped ${label}`);
      })
    ),

    // -- PressKey -------------------------------------------------------------
    tool(
      "SimulatorPressKey",
      `Press a special key on the iOS simulator. "home" triggers the home button.`,
      {
        key: z
          .enum(["return", "delete", "escape", "tab", "home", "space"])
          .describe("The key to press"),
        destination: z.string().optional().describe("Simulator name or UDID"),
      },
      withSimulator(async (args) => {
        const udid = await SimOps.resolveDevice(args.destination, sessionId);
        await SimOps.pressKey(udid, args.key);
        return textResult(`Pressed ${args.key}`);
      })
    ),

    // -- Build ----------------------------------------------------------------
    tool(
      "SimulatorBuild",
      `Build the Xcode project, install it on the simulator, and launch the app. Returns build result with bundle ID and app name.

The simulator must be booted first. The build may take several minutes for large projects.`,
      {
        workingDirectory: z.string().describe("Path to the directory containing the Xcode project"),
        scheme: z.string().optional().describe("Build scheme name (auto-detected if not provided)"),
        destination: z.string().optional().describe("Simulator name or UDID to build for"),
      },
      withSimulator(async (args) => {
        const udid = await SimOps.resolveDevice(args.destination, sessionId);
        const result = await SimOps.buildAndRun(udid, {
          workingDirectory: args.workingDirectory,
          scheme: args.scheme,
        });

        return textResult(
          `Build succeeded.\nApp: ${result.appName}\nBundle ID: ${result.bundleId || "(unknown)"}\nInstalled and launched on simulator.`
        );
      })
    ),

    // -- Launch ---------------------------------------------------------------
    tool(
      "SimulatorLaunch",
      `Launch an app on the simulator by bundle ID. The app must already be installed. Use SimulatorListApps to discover installed bundle IDs.`,
      {
        bundleId: z.string().describe("Bundle identifier (e.g., com.example.MyApp)"),
        destination: z.string().optional().describe("Simulator name or UDID"),
      },
      withSimulator(async (args) => {
        const udid = await SimOps.resolveDevice(args.destination, sessionId);
        await SimOps.launch(udid, args.bundleId);
        return textResult(`Launched ${args.bundleId}`);
      })
    ),

    // -- ListApps -------------------------------------------------------------
    tool(
      "SimulatorListApps",
      `List apps installed on the simulator. Returns bundle IDs you can pass to SimulatorLaunch. Defaults to user-installed apps; pass type="all" to include system apps.`,
      {
        destination: z.string().optional().describe("Simulator name or UDID"),
        type: z
          .enum(["User", "System", "all"])
          .optional()
          .describe("Which apps to list (default: User)"),
      },
      withSimulator(async (args) => {
        const udid = await SimOps.resolveDevice(args.destination, sessionId);
        const apps = await SimOps.listApps(udid, { type: args.type });
        if (apps.length === 0) {
          return textResult("No apps found on this simulator.");
        }
        const lines = apps.map(
          (a) => `${a.name}${a.version ? ` (${a.version})` : ""} — ${a.bundleId} [${a.type}]`
        );
        return textResult(`Found ${apps.length} app(s):\n${lines.join("\n")}`);
      })
    ),

    // -- ReadScreen -----------------------------------------------------------
    tool(
      "SimulatorReadScreen",
      `Read the current screen state of the iOS simulator. Returns the accessibility tree with element refs (@e1, @e2) and optionally a screenshot.

Use refs with SimulatorTap to tap elements by label. Use filter "interactive" to see only tappable elements.`,
      {
        destination: z.string().optional().describe("Simulator name or UDID"),
        filter: z
          .enum(["interactive", "all"])
          .optional()
          .describe(
            "Filter: 'interactive' shows only tappable elements, 'all' shows everything (default)"
          ),
        includeScreenshot: z
          .boolean()
          .optional()
          .describe("Include screenshot in response (default: true)"),
      },
      withSimulator(async (args) => {
        const udid = await SimOps.resolveDevice(args.destination, sessionId);
        const result = await SimOps.readScreen(udid, {
          sessionKey: sessionId,
          filter: args.filter,
          includeScreenshot: args.includeScreenshot,
        });

        const parts: Array<{ type: string; [k: string]: unknown }> = [];

        if (result.screenshot) {
          parts.push({
            type: "image",
            data: result.screenshot.base64,
            mimeType: result.screenshot.mimeType,
          });
        }

        parts.push({ type: "text", text: result.formatted });
        return { content: parts };
      })
    ),

    // -- WaitFor --------------------------------------------------------------
    tool(
      "SimulatorWaitFor",
      `Wait for a condition on the simulator. Useful for waiting for animations, loading states, or specific UI elements to appear.`,
      {
        time: z
          .number()
          .max(300)
          .optional()
          .describe(
            "Wait for a fixed duration in SECONDS (not milliseconds). Accepts decimals (e.g. 1.5). Max 300s."
          ),
        stabilize: z
          .boolean()
          .optional()
          .describe("Wait for UI to stop changing (animations complete)"),
        label: z
          .string()
          .optional()
          .describe("Wait for an element with this accessibility label to appear"),
        timeout: z
          .number()
          .max(300)
          .optional()
          .describe("Maximum wait time in SECONDS (default: 30, max: 300)"),
        destination: z.string().optional().describe("Simulator name or UDID"),
      },
      withSimulator(async (args) => {
        const udid = await SimOps.resolveDevice(args.destination, sessionId);
        const result = await SimOps.waitFor(udid, args);

        if (args.time) {
          return textResult(`Waited ${args.time}s`);
        }

        return textResult(
          result.found
            ? `Condition met (${result.elapsedMs}ms)`
            : `Timed out after ${result.elapsedMs}ms`
        );
      })
    ),

    // -- GetProjectInfo -------------------------------------------------------
    tool(
      "SimulatorGetProjectInfo",
      `Get available build schemes and project files for an Xcode project. Use this before SimulatorBuild to discover available schemes.`,
      {
        workingDirectory: z.string().optional().describe("Path to the Xcode project directory"),
      },
      withSimulator(async (args) => {
        const cwd = args.workingDirectory;
        if (!cwd) return textResult("Provide a workingDirectory to inspect.");

        const info = await SimOps.getProjectInfo(cwd);

        const lines: string[] = [];
        if (info.workspace) lines.push(`Workspace: ${info.workspace}`);
        if (info.project) lines.push(`Project: ${info.project}`);
        if (info.schemes.length > 0) {
          lines.push(`\nSchemes:\n${info.schemes.map((s) => `  - ${s}`).join("\n")}`);
        } else {
          lines.push("\nNo schemes found.");
        }

        return textResult(lines.join("\n"));
      })
    ),
  ];
}
