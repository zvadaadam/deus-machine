// sidecar/agents/opendevs-tools/simulator.ts
// iOS Simulator automation tools: list devices, start, screenshot, tap, swipe, type text, press key, build & run.
// These tools proxy through FrontendClient RPC → Rust socket relay → Tauri event →
// frontend handler → existing sim-core Tauri IPC commands.
//
// Named "iOSSimulator*" to distinguish from external xcode-mcp tools.
// These tools control the in-app Simulator panel (MJPEG stream + HID input).

import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { FrontendClient } from "../../frontend-client";

/**
 * Creates the iOS simulator automation tool definitions for a given session.
 * These tools control the iOS simulator via the existing Rust sim-core
 * infrastructure (ObjC bridge for MJPEG streaming, HID input, xcodebuild).
 */
export function createSimulatorTools(sessionId: string): SdkMcpToolDefinition<any>[] {
  return [
    // ====================================================================
    // iOSSimulatorListDevices
    // ====================================================================
    tool(
      "iOSSimulatorListDevices",
      `List all available iOS simulators installed on the system.

Returns each simulator's name, UDID, state (Booted/Shutdown), runtime (iOS version), and device type. Use this to find a simulator to boot with iOSSimulatorStart.

Example output:
- iPhone 16 Pro (UDID: ABC123) - Shutdown - iOS-18-2
- iPhone 16e (UDID: DEF456) - Booted - iOS-26-1`,
      {},
      async () => {
        console.log(`[opendevsMCPServer] iOSSimulatorListDevices invoked for session ${sessionId}`);

        try {
          const response = await FrontendClient.requestSimListDevices({ sessionId });

          if (response.error) {
            return {
              content: [{ type: "text" as const, text: `Failed to list devices: ${response.error}` }],
            };
          }

          if (response.devices.length === 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "No iOS simulators found. Install simulators via Xcode → Settings → Platforms.",
                },
              ],
            };
          }

          const lines = response.devices.map(
            (d) => `- ${d.name} (${d.udid}) — ${d.state} — ${d.runtime}${d.deviceType ? ` — ${d.deviceType}` : ""}`
          );

          return {
            content: [
              {
                type: "text" as const,
                text: `Found ${response.devices.length} simulator(s):\n${lines.join("\n")}\n\nUse iOSSimulatorStart with a UDID to boot and start streaming a simulator.`,
              },
            ],
          };
        } catch (err: any) {
          return {
            content: [{ type: "text" as const, text: `Failed to list simulators: ${err.message}` }],
          };
        }
      }
    ),

    // ====================================================================
    // iOSSimulatorStart
    // ====================================================================
    tool(
      "iOSSimulatorStart",
      `Boot an iOS simulator and start MJPEG streaming in the app's Simulator panel.

This makes the simulator visible in the Simulator panel and enables all other iOSSimulator tools (Screenshot, Tap, Swipe, TypeText, PressKey, BuildAndRun).

Use iOSSimulatorListDevices first to find available simulators and their UDIDs.

After starting, the simulator stream will appear in the app's Simulator panel. Use iOSSimulatorScreenshot to see the screen and interact with it.`,
      {
        udid: z.string().describe("UDID of the simulator to boot (get from iOSSimulatorListDevices)"),
      },
      async (args) => {
        console.log(
          `[opendevsMCPServer] iOSSimulatorStart invoked for session ${sessionId}: udid=${args.udid}`
        );

        try {
          const response = await FrontendClient.requestSimStart({
            sessionId,
            udid: args.udid,
          });

          if (response.error) {
            return {
              content: [{ type: "text" as const, text: `Failed to start simulator: ${response.error}` }],
            };
          }

          const details = [
            `Simulator started and streaming.`,
            response.url ? `Stream URL: ${response.url}` : null,
            response.hidAvailable === false
              ? `Warning: HID not available — touch/key input may not work.`
              : null,
            `Use iOSSimulatorScreenshot to see the screen.`,
          ]
            .filter(Boolean)
            .join("\n");

          return {
            content: [{ type: "text" as const, text: details }],
          };
        } catch (err: any) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to start simulator: ${err.message}. Make sure the UDID is valid (use iOSSimulatorListDevices to check).`,
              },
            ],
          };
        }
      }
    ),

    // ====================================================================
    // iOSSimulatorScreenshot
    // ====================================================================
    tool(
      "iOSSimulatorScreenshot",
      `Capture a screenshot of the currently running iOS simulator. Returns a JPEG image of the simulator screen.

Use this to see the current state of the app running in the simulator before interacting with it. The screenshot shows exactly what the user would see on the device screen.

The simulator must be booted and streaming (use iOSSimulatorStart first).`,
      {},
      async () => {
        console.log(`[opendevsMCPServer] iOSSimulatorScreenshot invoked for session ${sessionId}`);

        try {
          const response = await FrontendClient.requestSimScreenshot({ sessionId });

          if (response.error) {
            return {
              content: [{ type: "text" as const, text: `Screenshot failed: ${response.error}` }],
            };
          }

          return {
            content: [
              {
                type: "image" as const,
                data: response.image,
                mimeType: "image/jpeg" as const,
              },
            ],
          };
        } catch (err: any) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Simulator not available: ${err.message}. Use iOSSimulatorStart to boot a simulator first.`,
              },
            ],
          };
        }
      }
    ),

    // ====================================================================
    // iOSSimulatorTap
    // ====================================================================
    tool(
      "iOSSimulatorTap",
      `Tap on the iOS simulator screen at the specified coordinates.

Coordinates are normalized (0.0 to 1.0) where:
- (0.0, 0.0) is the top-left corner
- (1.0, 1.0) is the bottom-right corner
- (0.5, 0.5) is the center of the screen

Use iOSSimulatorScreenshot first to see the current screen, then estimate the coordinates of the element you want to tap.`,
      {
        x: z.number().min(0).max(1).describe("Normalized X coordinate (0.0–1.0, left to right)"),
        y: z.number().min(0).max(1).describe("Normalized Y coordinate (0.0–1.0, top to bottom)"),
      },
      async (args) => {
        console.log(
          `[opendevsMCPServer] iOSSimulatorTap invoked for session ${sessionId}: (${args.x}, ${args.y})`
        );

        try {
          const response = await FrontendClient.requestSimTap({
            sessionId,
            x: args.x,
            y: args.y,
          });

          if (response.error) {
            return {
              content: [{ type: "text" as const, text: `Tap failed: ${response.error}` }],
            };
          }

          return {
            content: [
              {
                type: "text" as const,
                text: `Tapped at (${args.x.toFixed(2)}, ${args.y.toFixed(2)}). Use iOSSimulatorScreenshot to see the result.`,
              },
            ],
          };
        } catch (err: any) {
          return {
            content: [{ type: "text" as const, text: `Simulator not available: ${err.message}` }],
          };
        }
      }
    ),

    // ====================================================================
    // iOSSimulatorSwipe
    // ====================================================================
    tool(
      "iOSSimulatorSwipe",
      `Perform a swipe gesture on the iOS simulator screen.

Coordinates are normalized (0.0 to 1.0). Common swipe patterns:
- Scroll down: startY=0.7, endY=0.3 (finger moves up)
- Scroll up: startY=0.3, endY=0.7 (finger moves down)
- Swipe left: startX=0.8, endX=0.2
- Swipe right: startX=0.2, endX=0.8`,
      {
        startX: z.number().min(0).max(1).describe("Start X coordinate (0.0–1.0)"),
        startY: z.number().min(0).max(1).describe("Start Y coordinate (0.0–1.0)"),
        endX: z.number().min(0).max(1).describe("End X coordinate (0.0–1.0)"),
        endY: z.number().min(0).max(1).describe("End Y coordinate (0.0–1.0)"),
        durationMs: z
          .number()
          .optional()
          .describe("Duration of the swipe in milliseconds (default: 300)"),
      },
      async (args) => {
        console.log(
          `[opendevsMCPServer] iOSSimulatorSwipe invoked for session ${sessionId}: ` +
            `(${args.startX}, ${args.startY}) → (${args.endX}, ${args.endY})`
        );

        try {
          const response = await FrontendClient.requestSimSwipe({
            sessionId,
            startX: args.startX,
            startY: args.startY,
            endX: args.endX,
            endY: args.endY,
            durationMs: args.durationMs,
          });

          if (response.error) {
            return {
              content: [{ type: "text" as const, text: `Swipe failed: ${response.error}` }],
            };
          }

          return {
            content: [
              {
                type: "text" as const,
                text: `Swiped from (${args.startX.toFixed(2)}, ${args.startY.toFixed(2)}) to (${args.endX.toFixed(2)}, ${args.endY.toFixed(2)}). Use iOSSimulatorScreenshot to see the result.`,
              },
            ],
          };
        } catch (err: any) {
          return {
            content: [{ type: "text" as const, text: `Simulator not available: ${err.message}` }],
          };
        }
      }
    ),

    // ====================================================================
    // iOSSimulatorTypeText
    // ====================================================================
    tool(
      "iOSSimulatorTypeText",
      `Type text into the currently focused field in the iOS simulator.

Make sure an input field is focused first (tap on it using iOSSimulatorTap). The text is typed character by character using HID key injection, simulating a real keyboard.`,
      {
        text: z.string().describe("The text to type into the focused field"),
      },
      async (args) => {
        const preview = args.text.length > 30 ? `${args.text.slice(0, 30)}...` : args.text;
        console.log(
          `[opendevsMCPServer] iOSSimulatorTypeText invoked for session ${sessionId}: "${preview}"`
        );

        try {
          const response = await FrontendClient.requestSimTypeText({
            sessionId,
            text: args.text,
          });

          if (response.error) {
            return {
              content: [{ type: "text" as const, text: `Type failed: ${response.error}` }],
            };
          }

          return {
            content: [
              {
                type: "text" as const,
                text: `Typed "${args.text.length > 50 ? args.text.slice(0, 50) + "..." : args.text}". Use iOSSimulatorScreenshot to see the result.`,
              },
            ],
          };
        } catch (err: any) {
          return {
            content: [{ type: "text" as const, text: `Simulator not available: ${err.message}` }],
          };
        }
      }
    ),

    // ====================================================================
    // iOSSimulatorPressKey
    // ====================================================================
    tool(
      "iOSSimulatorPressKey",
      `Press a specific key on the iOS simulator using USB HID usage codes.

Common keycodes (USB HID):
- Return/Enter: 0x28 (40)
- Delete/Backspace: 0x2A (42)
- Escape: 0x29 (41)
- Tab: 0x2B (43)
- Space: 0x2C (44)
- Arrow Up: 0x52 (82), Down: 0x51 (81), Left: 0x50 (80), Right: 0x4F (79)
- Left Shift: 0xE1 (225)

By default, sends both key-down and key-up. Use direction to send only one.`,
      {
        keycode: z.number().describe("USB HID usage code (e.g., 40 for Return, 42 for Backspace)"),
        direction: z
          .enum(["down", "up"])
          .optional()
          .describe("Send only key-down or key-up. Omit for a full key press (down + up)."),
      },
      async (args) => {
        console.log(
          `[opendevsMCPServer] iOSSimulatorPressKey invoked for session ${sessionId}: keycode=${args.keycode}`
        );

        try {
          const response = await FrontendClient.requestSimPressKey({
            sessionId,
            keycode: args.keycode,
            direction: args.direction,
          });

          if (response.error) {
            return {
              content: [{ type: "text" as const, text: `Key press failed: ${response.error}` }],
            };
          }

          return {
            content: [
              {
                type: "text" as const,
                text: `Pressed key ${args.keycode}${args.direction ? ` (${args.direction})` : ""}. Use iOSSimulatorScreenshot to see the result.`,
              },
            ],
          };
        } catch (err: any) {
          return {
            content: [{ type: "text" as const, text: `Simulator not available: ${err.message}` }],
          };
        }
      }
    ),

    // ====================================================================
    // iOSSimulatorBuildAndRun
    // ====================================================================
    tool(
      "iOSSimulatorBuildAndRun",
      `Build an Xcode project and install + launch the app on the currently booted iOS simulator.

This tool:
1. Detects the Xcode project in the workspace
2. Runs xcodebuild to compile the project
3. Installs the built .app on the booted simulator
4. Launches the app

The simulator must be booted and streaming (use iOSSimulatorStart first). The build may take several minutes for large projects.`,
      {
        workspacePath: z
          .string()
          .describe("Absolute path to the workspace directory containing the Xcode project"),
      },
      async (args) => {
        console.log(
          `[opendevsMCPServer] iOSSimulatorBuildAndRun invoked for session ${sessionId}: ${args.workspacePath}`
        );

        try {
          const response = await FrontendClient.requestSimBuildAndRun({
            sessionId,
            workspacePath: args.workspacePath,
          });

          if (response.error) {
            return {
              content: [
                { type: "text" as const, text: `Build & run failed: ${response.error}` },
              ],
            };
          }

          const details = [
            `Build & run succeeded.`,
            response.appName ? `App: ${response.appName}` : null,
            response.bundleId ? `Bundle ID: ${response.bundleId}` : null,
            `Use iOSSimulatorScreenshot to see the running app.`,
          ]
            .filter(Boolean)
            .join("\n");

          return {
            content: [{ type: "text" as const, text: details }],
          };
        } catch (err: any) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Build & run failed: ${err.message}. Make sure a simulator is booted (use iOSSimulatorStart) and the workspace contains an Xcode project.`,
              },
            ],
          };
        }
      }
    ),
  ];
}
