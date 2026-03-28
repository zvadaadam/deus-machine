// Browser automation tools powered by agent-browser CLI.
// Each tool executes agent-browser commands via CDP (Chrome DevTools Protocol).
// The daemon auto-starts on first use per session.
//
// Key features:
// - Coordinate return: click/type/hover return element bounding boxes for screen recording
// - Batch mode: BrowserBatchActions executes multiple commands in one round-trip
// - Snapshot filtering: interactive-only, compact, depth-limited, CSS-scoped
// - Wait modes: text, networkIdle, elementVisible, elementGone

import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { writeFileSync, mkdirSync, existsSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";
import { getErrorMessage } from "@shared/lib/errors";
import {
  execAgentBrowser,
  execWithSnapshot,
  executeBatch,
  getSnapshot,
  type ElementBox,
} from "./agent-browser-client";

// ============================================================================
// Snapshot file-based fallback constants
// ============================================================================

const SNAPSHOT_SIZE_THRESHOLD = 25 * 1024; // 25 KB for action tools
const SNAPSHOT_SIZE_THRESHOLD_LARGE = 200 * 1024; // 200 KB for BrowserSnapshot
const PREVIEW_LINE_COUNT = 50;
const BROWSER_LOGS_DIR = join(homedir(), ".deus", "browser-logs");

// ============================================================================
// Shared response helpers
// ============================================================================

/** Wrap a tool handler with standard [browser] logging and error catch */
function withBrowserTool<TArgs>(
  name: string,
  sessionId: string,
  logExtra: (args: TArgs) => string,
  fn: (args: TArgs) => Promise<{ content: Array<{ type: string; [key: string]: unknown }> }>
): (args: TArgs) => Promise<{ content: Array<{ type: string; [key: string]: unknown }> }> {
  return async (args: TArgs) => {
    const extra = logExtra(args);
    console.log(`[browser] ${name} invoked for session ${sessionId}${extra ? `: ${extra}` : ""}`);
    try {
      return await fn(args);
    } catch (err: unknown) {
      return textResult(`Browser not available: ${getErrorMessage(err)}`);
    }
  };
}

/** Build a single-text-block tool result */
function textResult(text: string): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text }] };
}

/**
 * Format a snapshot response with file-based fallback for large snapshots.
 * Optionally includes element bounding box for screen recording.
 */
function formatSnapshotResponse(
  action: string,
  snapshot: string | undefined,
  pageUrl?: string,
  pageTitle?: string,
  detailLines?: string[],
  sizeThreshold: number = SNAPSHOT_SIZE_THRESHOLD,
  elementBox?: ElementBox | null
): string {
  const sections: string[] = [];

  sections.push(`### Action: ${action}`);
  if (detailLines && detailLines.length > 0) {
    for (const line of detailLines) {
      sections.push(`- ${line}`);
    }
  }

  if (elementBox) {
    const cx = Math.round(elementBox.x + elementBox.width / 2);
    const cy = Math.round(elementBox.y + elementBox.height / 2);
    sections.push("");
    sections.push("### Element");
    sections.push(
      `- Bounding box: x=${Math.round(elementBox.x)} y=${Math.round(elementBox.y)} w=${Math.round(elementBox.width)} h=${Math.round(elementBox.height)}`
    );
    sections.push(`- Center: (${cx}, ${cy})`);
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
      filePath = join(BROWSER_LOGS_DIR, `snapshot-${timestamp}.log`);
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
    } else {
      sections.push(
        `- Page Snapshot: Large snapshot (${snapshotBytes} bytes, ${snapshotLines.length} lines) — truncated inline`
      );
      sections.push("");
      sections.push(snapshotLines.slice(0, PREVIEW_LINE_COUNT).join("\n"));
    }

    const remaining = snapshotLines.length - PREVIEW_LINE_COUNT;
    if (remaining > 0) {
      sections.push("");
      sections.push(
        filePath
          ? `... (${remaining} more lines in file)`
          : `... (${remaining} more lines truncated)`
      );
    }
  }

  return sections.join("\n");
}

/**
 * Creates the browser automation tool definitions for a given session.
 */
export function createBrowserTools(sessionId: string): SdkMcpToolDefinition<any>[] {
  return [
    tool(
      "BrowserSnapshot",
      `Capture an accessibility snapshot of the current browser page. Returns a YAML-formatted tree with element roles, names, and reference IDs (@e1, @e2).

Use ref IDs to target elements with BrowserClick, BrowserType, BrowserHover, BrowserSelectOption.

Options:
- filter: "interactive" shows only buttons/links/inputs (recommended for most tasks). "compact" removes empty structural nodes. "all" (default) shows full tree.
- depth: Limit nesting depth (e.g., 3 for shallow pages).
- selector: CSS selector to scope the snapshot (e.g., "#main", ".form-container").

For large pages, the snapshot is saved to a file and a preview is returned.`,
      {
        filter: z
          .enum(["all", "interactive", "compact"])
          .optional()
          .describe(
            "Filter mode: 'interactive' shows only actionable elements, 'compact' removes empty nodes, 'all' shows full tree (default)"
          ),
        depth: z.number().optional().describe("Limit tree depth to N levels"),
        selector: z
          .string()
          .optional()
          .describe("CSS selector to scope snapshot to a subtree (e.g., '#main')"),
      },
      withBrowserTool("BrowserSnapshot", sessionId, () => "", async (args) => {
        const response = await getSnapshot(sessionId, 20_000, {
          interactive: args.filter === "interactive",
          compact: args.filter === "compact",
          depth: args.depth,
          selector: args.selector,
        });

        if (response.error) {
          return textResult(`Error capturing snapshot: ${response.error}`);
        }

        return textResult(
          formatSnapshotResponse(
            "snapshot",
            response.snapshot,
            response.url,
            response.title,
            args.filter ? [`Filter: ${args.filter}`] : undefined,
            SNAPSHOT_SIZE_THRESHOLD_LARGE
          )
        );
      })
    ),

    tool(
      "BrowserClick",
      `Click on a web page element by reference ID or coordinates.

Preferred: Use BrowserSnapshot first to get element refs, then click by ref.
Fallback: Provide x/y pixel coordinates for elements without refs (canvas, custom widgets).

Returns a page snapshot after clicking and the clicked element's bounding box (x, y, width, height) for screen recording.`,
      {
        ref: z
          .string()
          .optional()
          .describe(
            "Element reference from the accessibility snapshot (e.g., '@e1'). Required unless x/y are provided."
          ),
        x: z
          .number()
          .optional()
          .describe("X coordinate in pixels for coordinate-based click. Use with y."),
        y: z
          .number()
          .optional()
          .describe("Y coordinate in pixels for coordinate-based click. Use with x."),
        doubleClick: z.boolean().optional().describe("Whether to perform a double click"),
      },
      withBrowserTool(
        "BrowserClick",
        sessionId,
        (args) => `target=${args.ref ?? `(${args.x}, ${args.y})`}`,
        async (args) => {
          if (!args.ref && (args.x === undefined || args.y === undefined)) {
            return textResult(
              "Click requires either 'ref' (e.g., '@e1') or both 'x' and 'y' coordinates."
            );
          }

          let response;
          if (args.ref) {
            const clickArgs = args.doubleClick
              ? ["click", "--double", args.ref]
              : ["click", args.ref];
            response = await execWithSnapshot(sessionId, clickArgs, undefined, args.ref);
          } else {
            const cmds: string[][] = [
              ["mouse", "move", String(args.x), String(args.y)],
              ["mouse", "down"],
              ["mouse", "up"],
            ];
            if (args.doubleClick) {
              cmds.push(["mouse", "down"], ["mouse", "up"]);
            }
            const batchResult = await executeBatch(sessionId, cmds, { bail: true });
            if (!batchResult.success) {
              return textResult(`Click failed: ${batchResult.error ?? "unknown error"}`);
            }
            const snap = await getSnapshot(sessionId);
            if (snap.error) {
              return textResult(`Click succeeded but snapshot failed: ${snap.error}`);
            }
            response = { ...snap, elementBox: { x: args.x!, y: args.y!, width: 1, height: 1 } };
          }

          if (response.error) {
            return textResult(`Click failed: ${response.error}`);
          }

          const target = args.ref ?? `(${args.x}, ${args.y})`;
          return textResult(
            formatSnapshotResponse(
              "click",
              response.snapshot,
              response.url,
              response.title,
              [
                `Click type: ${args.doubleClick ? "double-click" : "single-click"}`,
                `Target: ${target}`,
              ],
              SNAPSHOT_SIZE_THRESHOLD,
              response.elementBox
            )
          );
        }
      )
    ),

    tool(
      "BrowserType",
      `Type text into an input element. Use BrowserSnapshot first to find the target input's ref.

The element is focused and text is entered. Use submit: true to press Enter after typing.
Returns a page snapshot and the input element's bounding box.`,
      {
        ref: z
          .string()
          .describe("Element reference from the accessibility snapshot (e.g., '@e3')"),
        text: z.string().describe("Text to type into the element"),
        submit: z
          .boolean()
          .optional()
          .describe("Press Enter after typing to submit the form"),
        slowly: z
          .boolean()
          .optional()
          .describe(
            "Type character by character (useful for autocomplete or key handlers)"
          ),
      },
      withBrowserTool(
        "BrowserType",
        sessionId,
        (args) => `ref=${args.ref}`,
        async (args) => {
          const cmd = args.slowly ? "type" : "fill";
          const response = await execWithSnapshot(
            sessionId,
            [cmd, args.ref, args.text],
            undefined,
            args.ref
          );

          if (response.error) {
            return textResult(`Type failed: ${response.error}`);
          }

          let finalResponse = response;
          if (args.submit) {
            const submitResult = await execAgentBrowser(sessionId, ["press", "Enter"]);
            if (!submitResult.success) {
              return textResult(`Submit failed: ${submitResult.error ?? "unknown error"}`);
            }
            const snap = await getSnapshot(sessionId);
            finalResponse = { ...snap, elementBox: response.elementBox };
          }

          const details = [
            `Characters typed: ${args.text.length}`,
            `Mode: ${args.slowly ? "slow (character-by-character)" : "fast (batch fill)"}`,
          ];
          if (args.submit) details.push("Form submitted: yes");

          return textResult(
            formatSnapshotResponse(
              "type",
              finalResponse.snapshot,
              finalResponse.url,
              finalResponse.title,
              details,
              SNAPSHOT_SIZE_THRESHOLD,
              finalResponse.elementBox
            )
          );
        }
      )
    ),

    tool(
      "BrowserNavigate",
      `Navigate the browser to a URL. Returns an accessibility snapshot of the loaded page.`,
      {
        url: z.string().describe("The URL to navigate to"),
      },
      withBrowserTool(
        "BrowserNavigate",
        sessionId,
        (args) => {
          try {
            const u = new URL(args.url);
            return `url=${u.origin}${u.pathname}`;
          } catch {
            return `url=${args.url.replace(/[?#].*$/, "")}`;
          }
        },
        async (args) => {
          const response = await execWithSnapshot(sessionId, ["open", args.url], 30_000);

          if (response.error) {
            return textResult(`Navigation failed: ${response.error}`);
          }

          return textResult(
            formatSnapshotResponse("navigate", response.snapshot, response.url, response.title)
          );
        }
      )
    ),

    tool(
      "BrowserWaitFor",
      `Wait for a condition on the page before continuing. Use after actions that trigger async changes (navigation, form submission, AJAX).

Provide exactly ONE of:
- text: Wait for text to appear (substring match)
- textGone: Wait for text to disappear
- time: Wait a fixed number of seconds
- networkIdle: Wait for all network requests to settle (no activity for 500ms)
- elementVisible: Wait for element to become visible (ref or CSS selector)
- elementGone: Wait for element to disappear (ref or CSS selector)

Returns a page snapshot after the condition is met.`,
      {
        text: z.string().optional().describe("Wait until this text appears on the page"),
        textGone: z
          .string()
          .optional()
          .describe("Wait until this text disappears from the page"),
        time: z.number().optional().describe("Wait for a fixed number of seconds"),
        networkIdle: z
          .boolean()
          .optional()
          .describe("Wait for network activity to settle (no requests for 500ms)"),
        elementVisible: z
          .string()
          .optional()
          .describe("Wait for element to become visible (ref like '@e5' or CSS selector)"),
        elementGone: z
          .string()
          .optional()
          .describe("Wait for element to disappear (ref like '@e3' or CSS selector like '.spinner')"),
        timeout: z
          .number()
          .optional()
          .describe("Maximum wait time in seconds (default: 30)"),
      },
      withBrowserTool(
        "BrowserWaitFor",
        sessionId,
        (args) => {
          const selected = [
            args.text !== undefined && "text",
            args.textGone !== undefined && "textGone",
            args.time !== undefined && "time",
            args.networkIdle === true && "networkIdle",
            args.elementVisible !== undefined && "elementVisible",
            args.elementGone !== undefined && "elementGone",
          ].filter(Boolean) as string[];
          return `mode=${selected.length === 1 ? selected[0] : "invalid"}`;
        },
        async (args) => {
          const selected = [
            args.text !== undefined && "text",
            args.textGone !== undefined && "textGone",
            args.time !== undefined && "time",
            args.networkIdle === true && "networkIdle",
            args.elementVisible !== undefined && "elementVisible",
            args.elementGone !== undefined && "elementGone",
          ].filter(Boolean) as string[];

          if (selected.length !== 1) {
            return textResult(
              "Provide exactly one of: text, textGone, time, networkIdle, elementVisible, or elementGone."
            );
          }
          const mode = selected[0]!;

          const waitArgs: string[] = ["wait"];
          if (args.text !== undefined) {
            waitArgs.push("--text", args.text);
          } else if (args.textGone !== undefined) {
            waitArgs.push("--text-gone", args.textGone);
          } else if (args.time !== undefined) {
            waitArgs.push("--time", String(args.time * 1000));
          } else if (args.networkIdle === true) {
            waitArgs.push("--load", "networkidle");
          } else if (args.elementVisible !== undefined) {
            waitArgs.push(args.elementVisible);
          } else if (args.elementGone !== undefined) {
            waitArgs.push(args.elementGone, "--state", "hidden");
          }
          if (args.timeout !== undefined) {
            waitArgs.push("--timeout", String(args.timeout * 1000));
          }

          const response = await execWithSnapshot(sessionId, waitArgs, 35_000);

          if (response.error) {
            return textResult(`Wait failed: ${response.error}`);
          }

          const details: string[] = [`Wait mode: ${mode}`];
          if (args.text) details.push(`Waited for text: "${args.text}"`);
          if (args.textGone) details.push(`Waited for text to disappear: "${args.textGone}"`);
          if (args.time) details.push(`Waited: ${args.time}s`);
          if (args.networkIdle) details.push("Waited for network idle");
          if (args.elementVisible) details.push(`Waited for visible: ${args.elementVisible}`);
          if (args.elementGone) details.push(`Waited for gone: ${args.elementGone}`);

          return textResult(
            formatSnapshotResponse("wait_for", response.snapshot, response.url, response.title, details)
          );
        }
      )
    ),

    tool(
      "BrowserBatchActions",
      `Execute multiple browser commands in a single call. 10x faster than calling tools sequentially — one round-trip instead of many.

Each action is an array of strings matching agent-browser CLI commands:
- ["click", "@e1"] — click element
- ["fill", "@e3", "hello"] — fill input (fast, clears first)
- ["type", "@e3", "hello"] — type slowly (triggers key handlers)
- ["press", "Enter"] — press key
- ["scroll", "down", "600"] — scroll
- ["wait", "--text", "Done"] — wait for text
- ["hover", "@e2"] — hover element
- ["select", "@e4", "option1"] — select dropdown

Example — fill and submit a login form:
  actions: [["fill", "@e1", "user@example.com"], ["fill", "@e2", "password"], ["click", "@e3"]]

Returns a page snapshot after all actions complete.`,
      {
        actions: z
          .array(z.array(z.string()))
          .describe("Array of agent-browser commands. Each command is an array of strings."),
        bail: z
          .boolean()
          .optional()
          .describe("Stop on first error (default: false). Remaining actions are skipped."),
      },
      withBrowserTool(
        "BrowserBatchActions",
        sessionId,
        (args) => `${args.actions.length} actions`,
        async (args) => {
          const result = await executeBatch(sessionId, args.actions, {
            bail: args.bail,
            timeoutMs: 60_000,
          });

          if (!result.success) {
            return textResult(`Batch failed: ${result.error || "Unknown error"}`);
          }

          const batchData = result.data?.results as Array<Record<string, unknown>> | undefined;
          const failures: string[] = [];
          if (Array.isArray(batchData)) {
            batchData.forEach((r, i) => {
              if (r && r.success === false) {
                failures.push(`Action ${i + 1} (${args.actions[i]?.join(" ")}): ${r.error ?? "failed"}`);
              }
            });
          }

          const snap = await getSnapshot(sessionId);
          const actionSummary = args.actions
            .slice(0, 10)
            .map((a) => a.join(" "))
            .join(", ");
          const details = [
            `Actions executed: ${args.actions.length}`,
            `Commands: ${actionSummary}${args.actions.length > 10 ? ` ... (+${args.actions.length - 10} more)` : ""}`,
          ];

          if (failures.length > 0) {
            details.push(`Failures: ${failures.length}`);
            details.push(...failures.slice(0, 5));
            if (failures.length > 5) details.push(`... (+${failures.length - 5} more)`);
          }

          return textResult(
            formatSnapshotResponse("batch", snap.snapshot, snap.url, snap.title, details)
          );
        }
      )
    ),

    tool(
      "BrowserEvaluate",
      `Execute JavaScript in the browser page context. Use to extract data, check element states, interact with page APIs (localStorage, etc.).

Use 'return' to get results. Example: 'return document.title'`,
      {
        code: z
          .string()
          .describe(
            "JavaScript code to execute. Use 'return' to get results."
          ),
      },
      withBrowserTool("BrowserEvaluate", sessionId, () => "", async (args) => {
        const result = await execAgentBrowser(sessionId, ["eval", args.code]);

        if (!result.success) {
          return textResult(`Evaluate failed: ${result.error}`);
        }

        const evalResult = (result.data?.result as string) || JSON.stringify(result.data);
        return textResult(`Evaluation result: ${evalResult}`);
      })
    ),

    tool(
      "BrowserPressKey",
      `Press a key on the keyboard, dispatched to the currently focused element.
Use for keyboard shortcuts, form submission (Enter), navigation (Tab), dismissing dialogs (Escape).`,
      {
        key: z
          .string()
          .describe(
            "Key name: 'ArrowLeft', 'Enter', 'Tab', 'Escape', 'Backspace', 'a', '1'"
          ),
        ctrl: z.boolean().optional().describe("Hold Ctrl/Control key"),
        shift: z.boolean().optional().describe("Hold Shift key"),
        alt: z.boolean().optional().describe("Hold Alt/Option key"),
        meta: z.boolean().optional().describe("Hold Meta/Cmd key"),
      },
      withBrowserTool(
        "BrowserPressKey",
        sessionId,
        (args) => `key=${args.key}`,
        async (args) => {
          const parts: string[] = [];
          if (args.ctrl) parts.push("Control");
          if (args.shift) parts.push("Shift");
          if (args.alt) parts.push("Alt");
          if (args.meta) parts.push("Meta");
          parts.push(args.key);
          const keyCombo = parts.join("+");

          const result = await execAgentBrowser(sessionId, ["press", keyCombo]);

          if (!result.success) {
            return textResult(`PressKey failed: ${result.error}`);
          }

          return textResult(`Pressed key: ${keyCombo}`);
        }
      )
    ),

    tool(
      "BrowserHover",
      `Hover over an element to reveal tooltips, dropdown menus, or hover states.
Returns a page snapshot after hovering and the element's bounding box.`,
      {
        element: z.string().describe("Human-readable element description"),
        ref: z.string().describe("Element reference from the snapshot (e.g., '@e3')"),
      },
      withBrowserTool(
        "BrowserHover",
        sessionId,
        (args) => `ref=${args.ref}`,
        async (args) => {
          const response = await execWithSnapshot(
            sessionId,
            ["hover", args.ref],
            undefined,
            args.ref
          );

          if (response.error) {
            return textResult(`Hover failed: ${response.error}`);
          }

          return textResult(
            formatSnapshotResponse(
              "hover",
              response.snapshot,
              response.url,
              response.title,
              [`Element: ${args.element}`],
              SNAPSHOT_SIZE_THRESHOLD,
              response.elementBox
            )
          );
        }
      )
    ),

    tool(
      "BrowserSelectOption",
      `Select an option in a dropdown (<select> element). Returns a page snapshot after selection.`,
      {
        element: z.string().describe("Human-readable description of the dropdown"),
        ref: z.string().describe("Element reference for the <select> element"),
        values: z
          .array(z.string())
          .describe("Values to select (option values or visible text)"),
      },
      withBrowserTool(
        "BrowserSelectOption",
        sessionId,
        (args) => `ref=${args.ref}`,
        async (args) => {
          const response = await execWithSnapshot(
            sessionId,
            ["select", args.ref, ...args.values],
            undefined,
            args.ref
          );

          if (response.error) {
            return textResult(`SelectOption failed: ${response.error}`);
          }

          return textResult(
            formatSnapshotResponse(
              "select_option",
              response.snapshot,
              response.url,
              response.title,
              [`Dropdown: ${args.element}`, `Selected: ${args.values.join(", ")}`],
              SNAPSHOT_SIZE_THRESHOLD,
              response.elementBox
            )
          );
        }
      )
    ),

    tool(
      "BrowserNavigateBack",
      `Go back to the previous page in browser history. Returns a snapshot of the page.`,
      {},
      withBrowserTool("BrowserNavigateBack", sessionId, () => "", async () => {
        const response = await execWithSnapshot(sessionId, ["back"]);

        if (response.error) {
          return textResult(`NavigateBack failed: ${response.error}`);
        }

        return textResult(
          formatSnapshotResponse("navigate_back", response.snapshot, response.url, response.title)
        );
      })
    ),

    tool(
      "BrowserConsoleMessages",
      `Returns console messages (log, warn, error) captured since the page loaded.
Use to check for JavaScript errors or debug application behavior.`,
      {},
      withBrowserTool("BrowserConsoleMessages", sessionId, () => "", async () => {
        const result = await execAgentBrowser(sessionId, ["console", "--json"]);

        if (!result.success) {
          return textResult(`ConsoleMessages failed: ${result.error}`);
        }

        const messages = (result.data?.messages as string) || JSON.stringify(result.data);

        if (!messages || messages === "[]" || messages === "null") {
          return textResult("No console messages captured.");
        }

        return textResult(`Console messages:\n${messages}`);
      })
    ),

    tool(
      "BrowserScreenshot",
      `Capture a screenshot of the current browser page. Returns a PNG image.

Use to verify visual appearance, layout, or styling.
For structural/interactive analysis, prefer BrowserSnapshot instead.`,
      {
        ref: z
          .string()
          .optional()
          .describe("Element ref to screenshot just that element (e.g., '@e5')"),
      },
      withBrowserTool("BrowserScreenshot", sessionId, () => "", async (args) => {
        const screenshotPath = join(
          tmpdir(),
          `deus-screenshot-${sessionId}-${Date.now()}.png`
        );
        const screenshotArgs = ["screenshot", screenshotPath];
        if (args.ref) {
          screenshotArgs.push("--selector", args.ref);
        }

        const result = await execAgentBrowser(sessionId, screenshotArgs, 15_000);

        if (!result.success) {
          return textResult(`Screenshot failed: ${result.error}`);
        }

        const parts: Array<{ type: string; [key: string]: unknown }> = [];
        try {
          const imageBuffer = readFileSync(screenshotPath);
          parts.push({
            type: "image",
            data: imageBuffer.toString("base64"),
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
      })
    ),

    tool(
      "BrowserNetworkRequests",
      `Returns network requests made since the page loaded. Use to debug API calls and check response status codes.`,
      {},
      withBrowserTool("BrowserNetworkRequests", sessionId, () => "", async () => {
        const result = await execAgentBrowser(sessionId, ["network", "--json"]);

        if (!result.success) {
          return textResult(`NetworkRequests failed: ${result.error}`);
        }

        const requests = (result.data?.requests as string) || JSON.stringify(result.data);

        if (!requests || requests === "[]" || requests === "null") {
          return textResult("No network requests captured.");
        }

        return textResult(`Network requests:\n${requests}`);
      })
    ),

    tool(
      "BrowserScroll",
      `Scroll the page in a direction or scroll a specific element into view.

Two modes:
- Direction scroll: Scroll up/down/left/right by pixels (default 600px)
- Element scroll: Provide a ref to scroll that element into view

Returns a fresh snapshot after scrolling.`,
      {
        direction: z
          .enum(["up", "down", "left", "right"])
          .optional()
          .describe("Scroll direction (default: 'down'). Ignored when ref is provided."),
        amount: z
          .number()
          .optional()
          .describe("Pixels to scroll (default 600). Ignored when ref is provided."),
        ref: z
          .string()
          .optional()
          .describe(
            "Element ref to scroll into view. If provided, direction/amount are ignored."
          ),
      },
      withBrowserTool(
        "BrowserScroll",
        sessionId,
        (args) => `dir=${args.direction} ref=${args.ref}`,
        async (args) => {
          const scrollArgs = args.ref
            ? ["scroll", "--to", args.ref]
            : ["scroll", args.direction ?? "down", String(args.amount ?? 600)];

          const response = await execWithSnapshot(sessionId, scrollArgs);

          if (response.error) {
            return textResult(`Scroll failed: ${response.error}`);
          }

          const detail = args.ref
            ? `Scrolled element into view: ${args.ref}`
            : `Scrolled ${args.direction ?? "down"} by ${args.amount ?? 600}px`;

          return textResult(
            formatSnapshotResponse(
              "scroll",
              response.snapshot,
              response.url,
              response.title,
              [detail]
            )
          );
        }
      )
    ),
  ];
}
