// agent-server/agents/deus-tools/browser.ts
// Browser automation tools powered by agent-browser CLI.
// Each tool executes agent-browser commands via CDP (Chrome DevTools Protocol)
// in a headed Chrome window. The daemon auto-starts on first use per session.
//
// Snapshot file-based fallback:
// When a page snapshot exceeds SNAPSHOT_SIZE_THRESHOLD, the full snapshot
// is written to ~/.deus/browser-logs/ and only a preview (first N lines)
// is returned to the AI context. The AI can read the full file if needed.

import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { writeFileSync, mkdirSync, existsSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";
import { getErrorMessage } from "@shared/lib/errors";
import { execAgentBrowser, execWithSnapshot, getSnapshot } from "./agent-browser-client";

// ============================================================================
// Snapshot file-based fallback constants
// ============================================================================

const SNAPSHOT_SIZE_THRESHOLD = 25 * 1024; // 25 KB for action tools
const SNAPSHOT_SIZE_THRESHOLD_LARGE = 200 * 1024; // 200 KB for BrowserSnapshot
const PREVIEW_LINE_COUNT = 50;
const BROWSER_LOGS_DIR = join(homedir(), ".deus", "browser-logs");

/**
 * Format a snapshot response with file-based fallback for large snapshots.
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

  sections.push(`### Action: ${action}`);
  if (detailLines && detailLines.length > 0) {
    for (const line of detailLines) {
      sections.push(`- ${line}`);
    }
  }

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
    sections.push(`- Page Snapshot (${snapshotLines.length} lines)`);
    sections.push("");
    sections.push(snapshot);
  } else {
    let filePath: string | null = null;
    try {
      if (!existsSync(BROWSER_LOGS_DIR)) {
        mkdirSync(BROWSER_LOGS_DIR, { recursive: true });
      }
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `snapshot-${timestamp}.log`;
      filePath = join(BROWSER_LOGS_DIR, filename);
      writeFileSync(filePath, snapshot, "utf-8");
    } catch (err: unknown) {
      console.warn(`[browser] Failed to write snapshot file: ${getErrorMessage(err)}`);
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
 * These tools control a headed Chrome browser via agent-browser CLI and CDP.
 */
export function createBrowserTools(sessionId: string): SdkMcpToolDefinition<any>[] {
  return [
    // ====================================================================
    // BrowserSnapshot
    // ====================================================================
    tool(
      "BrowserSnapshot",
      `Capture an accessibility snapshot of the current browser page. Returns a YAML-formatted accessibility tree showing all interactive elements with their roles, names, and reference IDs.

Use the ref IDs (e.g. @e1, @e2) from the snapshot to target elements with BrowserClick and BrowserType tools.

The snapshot includes:
- Element roles (button, link, textbox, heading, etc.)
- Element names (visible text, aria-label)
- Reference IDs (@e1, @e2, etc.) for targeting
- Element states (focused, checked, disabled, expanded)
- URLs for links, values for inputs

For large pages, the snapshot is saved to a file and a preview is returned. Read the file for the full snapshot if needed.`,
      {},
      async () => {
        console.log(`[browser] BrowserSnapshot invoked for session ${sessionId}`);

        try {
          const response = await getSnapshot(sessionId, 20_000);

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
            SNAPSHOT_SIZE_THRESHOLD_LARGE
          );

          return { content: [{ type: "text", text }] };
        } catch (err: unknown) {
          return {
            content: [
              {
                type: "text",
                text: `Browser not available: ${getErrorMessage(err)}. Make sure the browser is open.`,
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

The element is clicked via Chrome DevTools Protocol. Returns a page snapshot after the click so you can see the updated state.`,
      {
        ref: z
          .string()
          .describe("The element reference from the accessibility snapshot (e.g., '@e1', '@e5')"),
        doubleClick: z.boolean().optional().describe("Whether to perform a double click"),
      },
      async (args) => {
        console.log(`[browser] BrowserClick invoked for session ${sessionId}: ref=${args.ref}`);

        try {
          const clickArgs = args.doubleClick
            ? ["click", "--double", args.ref]
            : ["click", args.ref];

          const response = await execWithSnapshot(sessionId, clickArgs);

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
        } catch (err: unknown) {
          return {
            content: [{ type: "text", text: `Browser not available: ${getErrorMessage(err)}` }],
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
        ref: z
          .string()
          .describe("The element reference from the accessibility snapshot (e.g., '@e3')"),
        text: z.string().describe("Text to type into the element"),
        submit: z.boolean().optional().describe("Whether to press Enter after typing to submit"),
        slowly: z
          .boolean()
          .optional()
          .describe(
            "Type character by character (useful for triggering autocomplete or key handlers)"
          ),
      },
      async (args) => {
        console.log(`[browser] BrowserType invoked for session ${sessionId}: ref=${args.ref}`);

        try {
          // Use 'fill' for fast input (clears + sets value), 'type' for slow character-by-character
          const cmd = args.slowly ? "type" : "fill";
          const typeArgs = [cmd, args.ref, args.text];

          const response = await execWithSnapshot(sessionId, typeArgs);

          if (response.error) {
            return {
              content: [{ type: "text", text: `Type failed: ${response.error}` }],
            };
          }

          // Press Enter if submit requested
          let finalResponse = response;
          if (args.submit) {
            const submitResult = await execAgentBrowser(sessionId, ["press", "Enter"]);
            if (!submitResult.success) {
              return {
                content: [
                  { type: "text", text: `Submit failed: ${submitResult.error ?? "unknown error"}` },
                ],
              };
            }
            finalResponse = await getSnapshot(sessionId);
          }

          const details = [
            `Characters typed: ${args.text.length}`,
            `Typing mode: ${args.slowly ? "slow (character-by-character)" : "fast (batch)"}`,
          ];
          if (args.submit) details.push("Form submitted: yes");

          const text = formatSnapshotResponse(
            "type",
            finalResponse.snapshot,
            finalResponse.url,
            finalResponse.title,
            details
          );

          return { content: [{ type: "text", text }] };
        } catch (err: unknown) {
          return {
            content: [{ type: "text", text: `Browser not available: ${getErrorMessage(err)}` }],
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
      },
      async (args) => {
        // Redact query/fragment to avoid leaking tokens, auth codes, etc. in logs
        const safeUrl = (() => {
          try {
            const u = new URL(args.url);
            return `${u.origin}${u.pathname}`;
          } catch {
            return args.url.replace(/[?#].*$/, "");
          }
        })();
        console.log(`[browser] BrowserNavigate invoked for session ${sessionId}: url=${safeUrl}`);

        try {
          const response = await execWithSnapshot(sessionId, ["open", args.url], 30_000);

          if (response.error) {
            return {
              content: [{ type: "text", text: `Navigation failed: ${response.error}` }],
            };
          }

          const text = formatSnapshotResponse(
            "navigate",
            response.snapshot,
            response.url,
            response.title
          );

          return { content: [{ type: "text", text }] };
        } catch (err: unknown) {
          return {
            content: [{ type: "text", text: `Browser not available: ${getErrorMessage(err)}` }],
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
        text: z.string().optional().describe("Wait until this text appears on the page"),
        textGone: z.string().optional().describe("Wait until this text disappears from the page"),
        time: z.number().optional().describe("Wait for a fixed number of seconds"),
        timeout: z.number().optional().describe("Maximum wait time in seconds (default: 30)"),
      },
      async (args) => {
        const mode = args.text
          ? "text"
          : args.textGone
            ? "textGone"
            : args.time
              ? "time"
              : "unknown";
        console.log(`[browser] BrowserWaitFor invoked for session ${sessionId}: mode=${mode}`);

        try {
          const waitArgs: string[] = ["wait"];
          if (args.text) {
            waitArgs.push("--text", args.text);
          } else if (args.textGone) {
            waitArgs.push("--text-gone", args.textGone);
          } else if (args.time) {
            waitArgs.push("--time", String(args.time * 1000)); // agent-browser uses ms
          }
          if (args.timeout) {
            waitArgs.push("--timeout", String(args.timeout * 1000));
          }

          const response = await execWithSnapshot(sessionId, waitArgs, 35_000);

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
        } catch (err: unknown) {
          return {
            content: [{ type: "text", text: `Browser not available: ${getErrorMessage(err)}` }],
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

Returns the result of the evaluation.`,
      {
        code: z
          .string()
          .describe(
            "JavaScript code to execute. Use 'return' to get results. " +
              "Example: 'return document.title'"
          ),
      },
      async (args) => {
        console.log(`[browser] BrowserEvaluate invoked for session ${sessionId}`);

        try {
          const result = await execAgentBrowser(sessionId, ["eval", args.code]);

          if (!result.success) {
            return {
              content: [{ type: "text", text: `Evaluate failed: ${result.error}` }],
            };
          }

          const evalResult = (result.data?.result as string) || JSON.stringify(result.data);

          return {
            content: [{ type: "text", text: `Evaluation result: ${evalResult}` }],
          };
        } catch (err: unknown) {
          return {
            content: [{ type: "text", text: `Browser not available: ${getErrorMessage(err)}` }],
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
Use this for keyboard shortcuts, form submission (Enter), navigation (Tab), dismissing dialogs (Escape).`,
      {
        key: z
          .string()
          .describe(
            "Name of the key to press, such as 'ArrowLeft', 'Enter', 'Tab', 'Escape', 'Backspace', 'a', '1'"
          ),
        ctrl: z.boolean().optional().describe("Hold Ctrl/Control key"),
        shift: z.boolean().optional().describe("Hold Shift key"),
        alt: z.boolean().optional().describe("Hold Alt/Option key"),
        meta: z.boolean().optional().describe("Hold Meta/Cmd key"),
      },
      async (args) => {
        console.log(`[browser] BrowserPressKey invoked for session ${sessionId}: key=${args.key}`);

        try {
          // Build modifier key combo: e.g. "Control+Shift+a"
          const parts: string[] = [];
          if (args.ctrl) parts.push("Control");
          if (args.shift) parts.push("Shift");
          if (args.alt) parts.push("Alt");
          if (args.meta) parts.push("Meta");
          parts.push(args.key);
          const keyCombo = parts.join("+");

          const result = await execAgentBrowser(sessionId, ["press", keyCombo]);

          if (!result.success) {
            return {
              content: [{ type: "text", text: `PressKey failed: ${result.error}` }],
            };
          }

          return {
            content: [{ type: "text", text: `Pressed key: ${keyCombo}` }],
          };
        } catch (err: unknown) {
          return {
            content: [{ type: "text", text: `Browser not available: ${getErrorMessage(err)}` }],
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
hover states, or any UI that appears on mouse hover. Returns a page snapshot after hovering.`,
      {
        element: z.string().describe("Human-readable element description"),
        ref: z.string().describe("Element reference from the page snapshot (e.g., '@e3')"),
      },
      async (args) => {
        console.log(`[browser] BrowserHover invoked for session ${sessionId}: ref=${args.ref}`);

        try {
          const response = await execWithSnapshot(sessionId, ["hover", args.ref]);

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
        } catch (err: unknown) {
          return {
            content: [{ type: "text", text: `Browser not available: ${getErrorMessage(err)}` }],
          };
        }
      }
    ),

    // ====================================================================
    // BrowserSelectOption
    // ====================================================================
    tool(
      "BrowserSelectOption",
      `Select an option in a dropdown (<select> element). Returns a page snapshot after selection.`,
      {
        element: z.string().describe("Human-readable description of the dropdown"),
        ref: z.string().describe("Element reference for the <select> element"),
        values: z.array(z.string()).describe("Values to select (option values or visible text)"),
      },
      async (args) => {
        console.log(
          `[browser] BrowserSelectOption invoked for session ${sessionId}: ref=${args.ref}`
        );

        try {
          const selectArgs = ["select", args.ref, ...args.values];
          const response = await execWithSnapshot(sessionId, selectArgs);

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
            [`Dropdown: ${args.element}`, `Selected values: ${args.values.join(", ")}`]
          );

          return { content: [{ type: "text", text }] };
        } catch (err: unknown) {
          return {
            content: [{ type: "text", text: `Browser not available: ${getErrorMessage(err)}` }],
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
      {},
      async () => {
        console.log(`[browser] BrowserNavigateBack invoked for session ${sessionId}`);

        try {
          const response = await execWithSnapshot(sessionId, ["back"]);

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
        } catch (err: unknown) {
          return {
            content: [{ type: "text", text: `Browser not available: ${getErrorMessage(err)}` }],
          };
        }
      }
    ),

    // ====================================================================
    // BrowserConsoleMessages
    // ====================================================================
    tool(
      "BrowserConsoleMessages",
      `Returns console messages (log, warn, error) captured since the page loaded.
Use this to check for JavaScript errors or debug application behavior.`,
      {},
      async () => {
        console.log(`[browser] BrowserConsoleMessages invoked for session ${sessionId}`);

        try {
          const result = await execAgentBrowser(sessionId, ["console", "--json"]);

          if (!result.success) {
            return {
              content: [{ type: "text", text: `ConsoleMessages failed: ${result.error}` }],
            };
          }

          const messages = (result.data?.messages as string) || JSON.stringify(result.data);

          if (!messages || messages === "[]" || messages === "null") {
            return {
              content: [{ type: "text", text: "No console messages captured." }],
            };
          }

          return {
            content: [{ type: "text", text: `Console messages:\n${messages}` }],
          };
        } catch (err: unknown) {
          return {
            content: [{ type: "text", text: `Browser not available: ${getErrorMessage(err)}` }],
          };
        }
      }
    ),

    // ====================================================================
    // BrowserScreenshot
    // ====================================================================
    tool(
      "BrowserScreenshot",
      `Capture a screenshot of the current browser page. Returns a JPEG image.

Use this when you need to verify visual appearance, layout, or styling.
For structural/interactive analysis, prefer BrowserSnapshot (accessibility tree) instead.`,
      {
        ref: z
          .string()
          .optional()
          .describe("Element ref to screenshot just that element (e.g., '@e5')"),
      },
      async (args) => {
        console.log(`[browser] BrowserScreenshot invoked for session ${sessionId}`);

        try {
          const screenshotPath = join(tmpdir(), `deus-screenshot-${sessionId}-${Date.now()}.png`);
          const screenshotArgs = ["screenshot", screenshotPath];
          if (args.ref) {
            screenshotArgs.push("--selector", args.ref);
          }

          const result = await execAgentBrowser(sessionId, screenshotArgs, 15_000);

          if (!result.success) {
            return {
              content: [{ type: "text", text: `Screenshot failed: ${result.error}` }],
            };
          }

          // Read screenshot file and return as base64 image
          const parts: Array<{ type: string; [key: string]: unknown }> = [];
          try {
            const imageBuffer = readFileSync(screenshotPath);
            const base64Data = imageBuffer.toString("base64");
            parts.push({
              type: "image",
              data: base64Data,
              mimeType: "image/png",
            });
            try {
              unlinkSync(screenshotPath);
            } catch {
              // Ignore cleanup errors
            }
          } catch {
            // File read failed — return text-only response
          }

          const urlResult = await execAgentBrowser(sessionId, ["get", "url", "--json"]);
          const url = (urlResult.data?.url as string) || "";
          let context = url ? `Screenshot of ${url}` : "Screenshot captured.";
          if (args.ref) context += ` (element: ${args.ref})`;
          parts.push({ type: "text", text: context });

          return { content: parts };
        } catch (err: unknown) {
          return {
            content: [
              {
                type: "text",
                text: `Browser not available: ${getErrorMessage(err)}. Make sure the browser is open.`,
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
      `Returns network requests made since the page loaded. Use this to debug API calls and check response status codes.`,
      {},
      async () => {
        console.log(`[browser] BrowserNetworkRequests invoked for session ${sessionId}`);

        try {
          const result = await execAgentBrowser(sessionId, ["network", "--json"]);

          if (!result.success) {
            return {
              content: [{ type: "text", text: `NetworkRequests failed: ${result.error}` }],
            };
          }

          const requests = (result.data?.requests as string) || JSON.stringify(result.data);

          if (!requests || requests === "[]" || requests === "null") {
            return {
              content: [{ type: "text", text: "No network requests captured." }],
            };
          }

          return {
            content: [{ type: "text", text: `Network requests:\n${requests}` }],
          };
        } catch (err: unknown) {
          return {
            content: [{ type: "text", text: `Browser not available: ${getErrorMessage(err)}` }],
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

Two modes:
- **Direction scroll**: Scroll up/down/left/right by a pixel amount (default 600px)
- **Element scroll**: Provide a ref to scroll that element into view

Returns a fresh accessibility snapshot after scrolling.`,
      {
        direction: z
          .enum(["up", "down", "left", "right"])
          .optional()
          .describe("Scroll direction. Default: 'down'. Ignored when ref is provided."),
        amount: z
          .number()
          .optional()
          .describe("Pixels to scroll (default 600). Ignored when ref is provided."),
        ref: z
          .string()
          .optional()
          .describe("Element ref to scroll into view. If provided, direction/amount are ignored."),
      },
      async (args) => {
        console.log(
          `[browser] BrowserScroll invoked for session ${sessionId}: dir=${args.direction} ref=${args.ref}`
        );

        try {
          let scrollArgs: string[];
          if (args.ref) {
            // Scroll element into view
            scrollArgs = ["scroll", "--to", args.ref];
          } else {
            const dir = args.direction ?? "down";
            const amount = args.amount ?? 600;
            scrollArgs = ["scroll", dir, String(amount)];
          }

          const response = await execWithSnapshot(sessionId, scrollArgs);

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
        } catch (err: unknown) {
          return {
            content: [{ type: "text", text: `Browser not available: ${getErrorMessage(err)}` }],
          };
        }
      }
    ),
  ];
}
