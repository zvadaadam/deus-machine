// sidecar/agents/conductor-tools/browser.ts
// Browser automation tools: snapshot, click, type, navigate, evaluate, etc.
//
// Snapshot file-based fallback (inspired by Cursor):
// When a page snapshot exceeds SNAPSHOT_SIZE_THRESHOLD, the full snapshot
// is written to ~/.conductor/browser-logs/ and only a preview (first N lines)
// is returned to the AI context. The AI can read the full file if needed.

import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { FrontendClient } from "../../frontend-client";

// ============================================================================
// Snapshot file-based fallback constants
// ============================================================================

// Two-tier thresholds matching Cursor's approach:
// - Action tools (click, type, hover, etc.): 25 KB — keeps context compact
// - Dedicated snapshot tool: 200 KB — user explicitly asked for a snapshot
const SNAPSHOT_SIZE_THRESHOLD = 25 * 1024;         // 25 KB for action tools
const SNAPSHOT_SIZE_THRESHOLD_LARGE = 200 * 1024;  // 200 KB for BrowserSnapshot
const PREVIEW_LINE_COUNT = 50;
const BROWSER_LOGS_DIR = join(homedir(), ".conductor", "browser-logs");

/**
 * Format a snapshot response with file-based fallback for large snapshots.
 *
 * If the snapshot is within the threshold, it's returned inline.
 * If it exceeds the threshold, the full snapshot is written to a file
 * and only a preview (first 50 lines) + file path is returned.
 *
 * @param action - Action name for the header (e.g., "click", "navigate")
 * @param snapshot - The full accessibility tree YAML snapshot
 * @param pageUrl - Current page URL
 * @param pageTitle - Current page title
 * @param detailLines - Optional action-specific detail lines
 * @param sizeThreshold - Byte threshold for file fallback (default: 25KB for actions)
 */
function formatSnapshotResponse(
  action: string,
  snapshot: string | undefined,
  pageUrl?: string,
  pageTitle?: string,
  detailLines?: string[],
  sizeThreshold: number = SNAPSHOT_SIZE_THRESHOLD
): string {
  const sections: string[] = [];

  // Action header with details
  sections.push(`### Action: ${action}`);
  if (detailLines && detailLines.length > 0) {
    for (const line of detailLines) {
      sections.push(`- ${line}`);
    }
  }

  // Page state
  sections.push("");
  sections.push("### Page state");
  if (pageUrl) sections.push(`- Page URL: ${pageUrl}`);
  if (pageTitle) sections.push(`- Page Title: ${pageTitle}`);

  if (!snapshot) {
    sections.push("- Page Snapshot: (not available)");
    return sections.join("\n");
  }

  const snapshotBytes = Buffer.byteLength(snapshot, "utf-8");
  const snapshotLines = snapshot.split("\n");

  if (snapshotBytes <= sizeThreshold) {
    // Small snapshot — return inline
    sections.push(`- Page Snapshot (${snapshotLines.length} lines)`);
    sections.push("");
    sections.push(snapshot);
  } else {
    // Large snapshot — write to file, return preview
    let filePath: string | null = null;
    try {
      if (!existsSync(BROWSER_LOGS_DIR)) {
        mkdirSync(BROWSER_LOGS_DIR, { recursive: true });
      }
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `snapshot-${timestamp}.log`;
      filePath = join(BROWSER_LOGS_DIR, filename);
      writeFileSync(filePath, snapshot, "utf-8");
    } catch (err: any) {
      // File write failed — fall back to truncated inline
      console.warn(`[browser] Failed to write snapshot file: ${err.message}`);
    }

    if (filePath) {
      sections.push(
        `- Page Snapshot: Large snapshot (${snapshotBytes} bytes, ${snapshotLines.length} lines) written to file`
      );
      sections.push(`- Snapshot File: ${filePath}`);
      sections.push(`- Preview (first ${PREVIEW_LINE_COUNT} lines):`);
      sections.push("");
      sections.push(snapshotLines.slice(0, PREVIEW_LINE_COUNT).join("\n"));
      const remaining = snapshotLines.length - PREVIEW_LINE_COUNT;
      if (remaining > 0) {
        sections.push("");
        sections.push(`... (${remaining} more lines in file)`);
      }
    } else {
      // File write failed — truncate inline
      const truncated = snapshotLines.slice(0, PREVIEW_LINE_COUNT).join("\n");
      sections.push(
        `- Page Snapshot: Large snapshot (${snapshotBytes} bytes, ${snapshotLines.length} lines) — truncated inline`
      );
      sections.push("");
      sections.push(truncated);
      const remaining = snapshotLines.length - PREVIEW_LINE_COUNT;
      if (remaining > 0) {
        sections.push("");
        sections.push(`... (${remaining} more lines truncated)`);
      }
    }
  }

  return sections.join("\n");
}

/**
 * Creates the browser automation tool definitions for a given session.
 * These tools control the embedded browser via accessibility tree snapshots
 * and element ref-based interactions.
 */
export function createBrowserTools(sessionId: string): SdkMcpToolDefinition<any>[] {
  return [
    // ====================================================================
    // BrowserSnapshot
    // ====================================================================
    tool(
      "BrowserSnapshot",
      `Capture an accessibility snapshot of the current browser page. Returns a YAML-formatted accessibility tree showing all interactive elements with their roles, names, and reference IDs.

Use the ref IDs from the snapshot to target elements with BrowserClick and BrowserType tools.

The snapshot includes:
- Element roles (button, link, textbox, heading, etc.)
- Element names (visible text, aria-label)
- Reference IDs (ref-xxx) for targeting
- Element states (focused, checked, disabled, expanded)
- URLs for links, values for inputs

For large pages, the snapshot is saved to a file and a preview is returned. Read the file for the full snapshot if needed.`,
      {
        webviewLabel: z
          .string()
          .optional()
          .describe("Target browser tab webview label. If omitted, uses the active tab."),
      },
      async (args) => {
        console.log(`[conductorMCPServer] BrowserSnapshot invoked for session ${sessionId}`);

        try {
          const response = await FrontendClient.requestBrowserSnapshot({
            sessionId,
            webviewLabel: args.webviewLabel,
          });

          if (response.error) {
            return {
              content: [{ type: "text", text: `Error capturing snapshot: ${response.error}` }],
            };
          }

          const text = formatSnapshotResponse(
            "snapshot",
            response.snapshot,
            response.url,
            response.title,
            undefined,
            SNAPSHOT_SIZE_THRESHOLD_LARGE // 200KB — higher limit for explicit snapshot requests
          );

          return { content: [{ type: "text", text }] };
        } catch (err: any) {
          return {
            content: [
              {
                type: "text",
                text: `Browser not available: ${err.message}. Make sure the browser tab is open.`,
              },
            ],
          };
        }
      }
    ),

    // ====================================================================
    // BrowserClick
    // ====================================================================
    tool(
      "BrowserClick",
      `Click on a web page element. Use BrowserSnapshot first to get element reference IDs.

The element is scrolled into view, focused, and clicked with proper mouse event simulation (mousedown → mouseup → click). Returns a page snapshot after the click so you can see the updated state.`,
      {
        ref: z.string().describe("The element's data-cursor-ref ID from the accessibility snapshot (e.g., 'ref-abc123')"),
        doubleClick: z.boolean().optional().describe("Whether to perform a double click"),
        webviewLabel: z.string().optional().describe("Target browser tab. If omitted, uses the active tab."),
      },
      async (args) => {
        console.log(`[conductorMCPServer] BrowserClick invoked for session ${sessionId}: ref=${args.ref}`);

        try {
          const response = await FrontendClient.requestBrowserClick({
            sessionId,
            ref: args.ref,
            doubleClick: args.doubleClick,
            webviewLabel: args.webviewLabel,
          });

          if (response.error) {
            return {
              content: [{ type: "text", text: `Click failed: ${response.error}` }],
            };
          }

          const text = formatSnapshotResponse(
            "click",
            response.snapshot,
            response.url,
            response.title,
            [
              `Click type: ${args.doubleClick ? "double-click" : "single-click"}`,
              `Target: ${args.ref}`,
            ]
          );

          return { content: [{ type: "text", text }] };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Browser not available: ${err.message}` }],
          };
        }
      }
    ),

    // ====================================================================
    // BrowserType
    // ====================================================================
    tool(
      "BrowserType",
      `Type text into an editable element on the page. Use BrowserSnapshot first to find the target input element's reference ID.

The element is focused and text is entered. Use submit: true to press Enter after typing. Returns a page snapshot after typing so you can see the updated state.`,
      {
        ref: z.string().describe("The element's data-cursor-ref ID from the accessibility snapshot"),
        text: z.string().describe("Text to type into the element"),
        submit: z.boolean().optional().describe("Whether to press Enter after typing to submit"),
        slowly: z.boolean().optional().describe("Type character by character (useful for triggering autocomplete or key handlers)"),
        webviewLabel: z.string().optional().describe("Target browser tab. If omitted, uses the active tab."),
      },
      async (args) => {
        console.log(`[conductorMCPServer] BrowserType invoked for session ${sessionId}: ref=${args.ref}`);

        try {
          const response = await FrontendClient.requestBrowserType({
            sessionId,
            ref: args.ref,
            text: args.text,
            submit: args.submit,
            slowly: args.slowly,
            webviewLabel: args.webviewLabel,
          });

          if (response.error) {
            return {
              content: [{ type: "text", text: `Type failed: ${response.error}` }],
            };
          }

          const details = [
            `Characters typed: ${args.text.length}`,
            `Typing mode: ${args.slowly ? "slow (character-by-character)" : "fast (batch)"}`,
          ];
          if (args.submit) details.push("Form submitted: yes");

          const text = formatSnapshotResponse(
            "type",
            response.snapshot,
            response.url,
            response.title,
            details
          );

          return { content: [{ type: "text", text }] };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Browser not available: ${err.message}` }],
          };
        }
      }
    ),

    // ====================================================================
    // BrowserNavigate
    // ====================================================================
    tool(
      "BrowserNavigate",
      `Navigate the browser to a URL. Returns an accessibility snapshot of the loaded page.`,
      {
        url: z.string().describe("The URL to navigate to"),
        webviewLabel: z.string().optional().describe("Target browser tab. If omitted, uses the active tab."),
      },
      async (args) => {
        console.log(`[conductorMCPServer] BrowserNavigate invoked for session ${sessionId}: url=${args.url}`);

        try {
          const response = await FrontendClient.requestBrowserNavigate({
            sessionId,
            url: args.url,
            webviewLabel: args.webviewLabel,
          });

          if (response.error) {
            return {
              content: [{ type: "text", text: `Navigation failed: ${response.error}` }],
            };
          }

          const details: string[] = [];
          if (response.webviewLabel) details.push(`Tab: ${response.webviewLabel}`);

          const text = formatSnapshotResponse(
            "navigate",
            response.snapshot,
            response.url,
            response.title,
            details
          );

          return { content: [{ type: "text", text }] };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Browser not available: ${err.message}` }],
          };
        }
      }
    ),

    // ====================================================================
    // BrowserWaitFor
    // ====================================================================
    tool(
      "BrowserWaitFor",
      `Wait for a condition on the page before continuing. Use this when you need to wait for:
- Dynamic content to load (AJAX, lazy loading, SPAs)
- Text to appear after an action (form submission, search results)
- Text to disappear (loading spinners, progress indicators)
- A fixed delay (animations, transitions)

Provide exactly one of: text, textGone, or time. Returns a page snapshot after the condition is met.`,
      {
        text: z.string().optional().describe("Wait until this text appears on the page (polls every 500ms)"),
        textGone: z.string().optional().describe("Wait until this text disappears from the page (polls every 500ms)"),
        time: z.number().optional().describe("Wait for a fixed number of seconds (e.g., 2 for 2 seconds)"),
        timeout: z.number().optional().describe("Maximum wait time in seconds (default: 30). Only applies to text/textGone modes."),
        webviewLabel: z.string().optional().describe("Target browser tab. If omitted, uses the active tab."),
      },
      async (args) => {
        const mode = args.text ? "text" : args.textGone ? "textGone" : args.time ? "time" : "unknown";
        console.log(`[conductorMCPServer] BrowserWaitFor invoked for session ${sessionId}: mode=${mode}`);

        try {
          const response = await FrontendClient.requestBrowserWaitFor({
            sessionId,
            text: args.text,
            textGone: args.textGone,
            time: args.time,
            timeout: args.timeout,
            webviewLabel: args.webviewLabel,
          });

          if (response.error) {
            return {
              content: [{ type: "text", text: `Wait failed: ${response.error}` }],
            };
          }

          const details: string[] = [`Wait mode: ${mode}`];
          if (args.text) details.push(`Waited for text: "${args.text}"`);
          if (args.textGone) details.push(`Waited for text to disappear: "${args.textGone}"`);
          if (args.time) details.push(`Waited: ${args.time}s`);

          const text = formatSnapshotResponse(
            "wait_for",
            response.snapshot,
            response.url,
            response.title,
            details
          );

          return { content: [{ type: "text", text }] };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Browser not available: ${err.message}` }],
          };
        }
      }
    ),
    // ====================================================================
    // BrowserEvaluate
    // ====================================================================
    tool(
      "BrowserEvaluate",
      `Execute JavaScript in the browser page context. Use this to:
- Extract data from the page (text, attributes, computed styles)
- Check element states (visibility, disabled, value)
- Run custom assertions or validations
- Interact with page APIs (localStorage, sessionStorage, etc.)

The code is wrapped in a Function constructor. Write it as a function body with a return statement.
If a ref is provided, the matching element is passed as the 'element' argument. Returns the result and a page snapshot.`,
      {
        code: z
          .string()
          .describe(
            "JavaScript function body to execute. Use 'return' to get results. " +
            "Example: 'return document.title' or 'return element.textContent' when ref is provided."
          ),
        ref: z
          .string()
          .optional()
          .describe("Element data-cursor-ref — if provided, the element is passed as 'element' argument"),
        webviewLabel: z.string().optional().describe("Target browser tab. If omitted, uses the active tab."),
      },
      async (args) => {
        console.log(`[conductorMCPServer] BrowserEvaluate invoked for session ${sessionId}`);

        try {
          const response = await FrontendClient.requestBrowserEvaluate({
            sessionId,
            code: args.code,
            ref: args.ref,
            webviewLabel: args.webviewLabel,
          });

          if (response.error) {
            return {
              content: [{ type: "text", text: `Evaluate failed: ${response.error}` }],
            };
          }

          const details: string[] = [];
          if (response.result) details.push(`Result: ${response.result}`);

          const text = formatSnapshotResponse(
            "evaluate",
            response.snapshot,
            undefined,
            undefined,
            details
          );

          return { content: [{ type: "text", text }] };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Browser not available: ${err.message}` }],
          };
        }
      }
    ),

    // ====================================================================
    // BrowserPressKey
    // ====================================================================
    tool(
      "BrowserPressKey",
      `Press a key on the keyboard. The key is dispatched to the currently focused element.
Use this for keyboard shortcuts, form submission (Enter), navigation (Tab), dismissing dialogs (Escape),
scrolling (ArrowDown, PageDown, Space), and text editing (Backspace, Delete).`,
      {
        key: z
          .string()
          .describe(
            "Name of the key to press or a character to generate, such as 'ArrowLeft', 'Enter', 'Tab', 'Escape', 'Backspace', 'a', '1'"
          ),
        ctrl: z.boolean().optional().describe("Hold Ctrl/Control key (e.g., Ctrl+A to select all)"),
        shift: z.boolean().optional().describe("Hold Shift key (e.g., Shift+Tab to go back)"),
        alt: z.boolean().optional().describe("Hold Alt/Option key"),
        meta: z.boolean().optional().describe("Hold Meta/Cmd key (e.g., Cmd+S to save)"),
        webviewLabel: z.string().optional().describe("Target browser tab. If omitted, uses the active tab."),
      },
      async (args) => {
        console.log(`[conductorMCPServer] BrowserPressKey invoked for session ${sessionId}: key=${args.key}`);

        try {
          const response = await FrontendClient.requestBrowserPressKey({
            sessionId,
            key: args.key,
            ctrl: args.ctrl,
            shift: args.shift,
            alt: args.alt,
            meta: args.meta,
            webviewLabel: args.webviewLabel,
          });

          if (response.error) {
            return {
              content: [{ type: "text", text: `PressKey failed: ${response.error}` }],
            };
          }

          return {
            content: [
              { type: "text", text: `Pressed key: ${args.key}` },
            ],
          };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Browser not available: ${err.message}` }],
          };
        }
      }
    ),

    // ====================================================================
    // BrowserHover
    // ====================================================================
    tool(
      "BrowserHover",
      `Hover over an element on the page. Use this to reveal tooltips, dropdown menus,
hover states, or any UI that appears on mouse hover. Returns a page snapshot after hovering so you can see what appeared.`,
      {
        element: z
          .string()
          .describe("Human-readable element description (e.g., 'the Settings button', 'user avatar')"),
        ref: z
          .string()
          .describe("Exact target element data-cursor-ref from the page snapshot"),
        webviewLabel: z.string().optional().describe("Target browser tab. If omitted, uses the active tab."),
      },
      async (args) => {
        console.log(`[conductorMCPServer] BrowserHover invoked for session ${sessionId}: ref=${args.ref}`);

        try {
          const response = await FrontendClient.requestBrowserHover({
            sessionId,
            ref: args.ref,
            webviewLabel: args.webviewLabel,
          });

          if (response.error) {
            return {
              content: [{ type: "text", text: `Hover failed: ${response.error}` }],
            };
          }

          const text = formatSnapshotResponse(
            "hover",
            response.snapshot,
            response.url,
            response.title,
            [`Element: ${args.element}`]
          );

          return { content: [{ type: "text", text }] };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Browser not available: ${err.message}` }],
          };
        }
      }
    ),

    // ====================================================================
    // BrowserSelectOption
    // ====================================================================
    tool(
      "BrowserSelectOption",
      `Select an option in a dropdown (<select> element). Provide one or more values
to select by option value or visible text. Returns a page snapshot after selection so you can see the updated state.`,
      {
        element: z
          .string()
          .describe("Human-readable description of the dropdown (e.g., 'country selector', 'language dropdown')"),
        ref: z
          .string()
          .describe("Exact target <select> element data-cursor-ref from the page snapshot"),
        values: z
          .array(z.string())
          .describe("Array of values to select. Can be option values or visible text labels."),
        webviewLabel: z.string().optional().describe("Target browser tab. If omitted, uses the active tab."),
      },
      async (args) => {
        console.log(`[conductorMCPServer] BrowserSelectOption invoked for session ${sessionId}: ref=${args.ref}`);

        try {
          const response = await FrontendClient.requestBrowserSelectOption({
            sessionId,
            ref: args.ref,
            values: args.values,
            webviewLabel: args.webviewLabel,
          });

          if (response.error) {
            return {
              content: [{ type: "text", text: `SelectOption failed: ${response.error}` }],
            };
          }

          const text = formatSnapshotResponse(
            "select_option",
            response.snapshot,
            response.url,
            response.title,
            [
              `Dropdown: ${args.element}`,
              `Selected values: ${args.values.join(", ")}`,
              `Matched: ${response.matched ?? args.values.length} option(s)`,
            ]
          );

          return { content: [{ type: "text", text }] };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Browser not available: ${err.message}` }],
          };
        }
      }
    ),

    // ====================================================================
    // BrowserNavigateBack
    // ====================================================================
    tool(
      "BrowserNavigateBack",
      `Go back to the previous page in browser history. Returns a snapshot of the page after navigating back.`,
      {
        webviewLabel: z.string().optional().describe("Target browser tab. If omitted, uses the active tab."),
      },
      async (args) => {
        console.log(`[conductorMCPServer] BrowserNavigateBack invoked for session ${sessionId}`);

        try {
          const response = await FrontendClient.requestBrowserNavigateBack({
            sessionId,
            webviewLabel: args.webviewLabel,
          });

          if (response.error) {
            return {
              content: [{ type: "text", text: `NavigateBack failed: ${response.error}` }],
            };
          }

          const text = formatSnapshotResponse(
            "navigate_back",
            response.snapshot,
            response.url,
            response.title
          );

          return { content: [{ type: "text", text }] };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Browser not available: ${err.message}` }],
          };
        }
      }
    ),

    // ====================================================================
    // BrowserConsoleMessages
    // ====================================================================
    tool(
      "BrowserConsoleMessages",
      `Returns all console messages (log, warn, error, debug) captured since the page loaded.
Use this to check for JavaScript errors, debug application behavior, or verify log output.
Messages are formatted as [LEVEL] message.`,
      {
        webviewLabel: z.string().optional().describe("Target browser tab. If omitted, uses the active tab."),
      },
      async (args) => {
        console.log(`[conductorMCPServer] BrowserConsoleMessages invoked for session ${sessionId}`);

        try {
          const response = await FrontendClient.requestBrowserConsoleMessages({
            sessionId,
            webviewLabel: args.webviewLabel,
          });

          if (response.error) {
            return {
              content: [{ type: "text", text: `ConsoleMessages failed: ${response.error}` }],
            };
          }

          if (response.count === 0) {
            return {
              content: [{ type: "text", text: "No console messages captured." }],
            };
          }

          return {
            content: [
              {
                type: "text",
                text: `Console messages (${response.count}):\n${response.logs}`,
              },
            ],
          };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Browser not available: ${err.message}` }],
          };
        }
      }
    ),

    // ====================================================================
    // BrowserScreenshot
    // ====================================================================
    tool(
      "BrowserScreenshot",
      `Capture a pixel screenshot of the current browser page. Returns a JPEG image that you can analyze visually.

Use this when you need to:
- Verify visual appearance, layout, or styling of a page
- Check that UI elements render correctly after actions
- Debug visual issues that the accessibility snapshot cannot reveal
- See images, colors, or visual design elements

You can capture:
- The full page (no extra params)
- A specific region using rect (x, y, width, height in CSS pixels)
- A specific element using ref (element's data-cursor-ref from a snapshot) — auto-crops to that element with padding

For structural/interactive page analysis, prefer BrowserSnapshot (accessibility tree) instead.`,
      {
        webviewLabel: z
          .string()
          .optional()
          .describe("Target browser tab webview label. If omitted, uses the active tab."),
        ref: z
          .string()
          .optional()
          .describe("Element ref ID from a BrowserSnapshot (e.g. 'ref-abc123'). Screenshots just that element with padding."),
        rect: z
          .object({
            x: z.number().describe("X offset in CSS pixels from left edge"),
            y: z.number().describe("Y offset in CSS pixels from top edge"),
            width: z.number().describe("Width in CSS pixels"),
            height: z.number().describe("Height in CSS pixels"),
          })
          .optional()
          .describe("Crop to a specific region. Takes priority over ref."),
      },
      async (args) => {
        console.log(`[conductorMCPServer] BrowserScreenshot invoked for session ${sessionId}`);

        try {
          let cropRect = args.rect;

          // If ref is provided (and no explicit rect), resolve element bounding rect
          if (!cropRect && args.ref) {
            try {
              const evalResponse = await FrontendClient.requestBrowserEvaluate({
                sessionId,
                webviewLabel: args.webviewLabel,
                code: `
                  var el = document.querySelector('[data-cursor-ref="${args.ref}"]');
                  if (!el) return JSON.stringify({ error: 'Element not found' });
                  var r = el.getBoundingClientRect();
                  var pad = 16;
                  return JSON.stringify({
                    x: Math.max(0, r.x - pad),
                    y: Math.max(0, r.y - pad),
                    width: r.width + pad * 2,
                    height: r.height + pad * 2
                  });
                `,
              });
              let parsed: any = {};
              try {
                parsed = JSON.parse(evalResponse.result || "{}");
              } catch {
                // Malformed JSON from webview eval — fall through to full-page screenshot
              }
              if (!parsed.error && parsed.width > 0 && parsed.height > 0) {
                cropRect = parsed;
              }
            } catch {
              // Fall through to full-page screenshot if ref resolution fails
            }
          }

          const response = await FrontendClient.requestBrowserScreenshot({
            sessionId,
            webviewLabel: args.webviewLabel,
            rect: cropRect,
          });

          if (response.error) {
            return {
              content: [{ type: "text", text: `Screenshot failed: ${response.error}` }],
            };
          }

          const parts: Array<{ type: string; [key: string]: unknown }> = [];

          // Return the image using MCP ImageContent format (data + mimeType at top level).
          // The Anthropic API format (source.data) causes "invalid result format" errors
          // when returned through createSdkMcpServer.
          if (response.image) {
            parts.push({
              type: "image",
              data: response.image,
              mimeType: "image/jpeg",
            });
          }

          // Add URL context as text
          let context = response.url
            ? `Screenshot of ${response.url}`
            : "Screenshot captured.";
          if (args.ref) context += ` (element: ${args.ref})`;
          if (cropRect) context += ` [region: ${Math.round(cropRect.x)},${Math.round(cropRect.y)} ${Math.round(cropRect.width)}x${Math.round(cropRect.height)}]`;
          parts.push({ type: "text", text: context });

          return { content: parts };
        } catch (err: any) {
          return {
            content: [
              {
                type: "text",
                text: `Browser not available: ${err.message}. Make sure the browser tab is open.`,
              },
            ],
          };
        }
      }
    ),

    // ====================================================================
    // BrowserNetworkRequests
    // ====================================================================
    tool(
      "BrowserNetworkRequests",
      `Returns all network requests made since the page loaded. Use this to:
- Debug API calls and check response status codes
- Verify that expected resources are loading
- Identify failed requests or slow endpoints
- Monitor XHR/fetch calls triggered by user actions

Requests are formatted as [TYPE] URL (duration, size).`,
      {
        webviewLabel: z.string().optional().describe("Target browser tab. If omitted, uses the active tab."),
      },
      async (args) => {
        console.log(`[conductorMCPServer] BrowserNetworkRequests invoked for session ${sessionId}`);

        try {
          const response = await FrontendClient.requestBrowserNetworkRequests({
            sessionId,
            webviewLabel: args.webviewLabel,
          });

          if (response.error) {
            return {
              content: [{ type: "text", text: `NetworkRequests failed: ${response.error}` }],
            };
          }

          if (response.count === 0) {
            return {
              content: [{ type: "text", text: "No network requests captured." }],
            };
          }

          return {
            content: [
              {
                type: "text",
                text: `Network requests (${response.count}):\n${response.requests}`,
              },
            ],
          };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Browser not available: ${err.message}` }],
          };
        }
      }
    ),

    // ====================================================================
    // BrowserScroll
    // ====================================================================
    tool(
      "BrowserScroll",
      `Scroll the page in a direction, or scroll a specific element into view.

Use this to navigate through long pages, load lazy content, or bring off-screen elements into the viewport.
Returns a fresh accessibility snapshot after scrolling with updated ref IDs.

Two modes:
- **Direction scroll**: Scroll up/down/left/right by a pixel amount (default 600px ≈ one viewport)
- **Element scroll**: Provide a ref to scroll that element into view (centered)

"down" scrolls the page content upward (reveals content below). "up" scrolls the page content downward (reveals content above).`,
      {
        direction: z
          .enum(["up", "down", "left", "right"])
          .optional()
          .describe("Scroll direction. Default: 'down'. Ignored when ref is provided."),
        amount: z
          .number()
          .optional()
          .describe("Pixels to scroll (default 600 ≈ one viewport height). Ignored when ref is provided."),
        ref: z
          .string()
          .optional()
          .describe("Element ref ID to scroll into view. If provided, direction/amount are ignored."),
        webviewLabel: z.string().optional().describe("Target browser tab. If omitted, uses the active tab."),
      },
      async (args) => {
        console.log(`[conductorMCPServer] BrowserScroll invoked for session ${sessionId}: dir=${args.direction} amount=${args.amount} ref=${args.ref}`);

        try {
          const response = await FrontendClient.requestBrowserScroll({
            sessionId,
            direction: args.direction,
            amount: args.amount,
            ref: args.ref,
            webviewLabel: args.webviewLabel,
          });

          if (response.error) {
            return {
              content: [{ type: "text", text: `Scroll failed: ${response.error}` }],
            };
          }

          const detailLines: string[] = [];
          if (args.ref) {
            detailLines.push(`Scrolled element into view: ${args.ref}`);
          } else {
            detailLines.push(`Scrolled ${args.direction ?? "down"} by ${args.amount ?? 600}px`);
          }

          const text = formatSnapshotResponse(
            "scroll",
            response.snapshot,
            response.url,
            response.title,
            detailLines
          );

          return { content: [{ type: "text", text }] };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Browser not available: ${err.message}` }],
          };
        }
      }
    ),
  ];
}
