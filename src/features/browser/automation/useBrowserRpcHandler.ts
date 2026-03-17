// src/features/browser/automation/useBrowserRpcHandler.ts
// Handles browser automation RPC requests from the agent-server.
//
// Architecture:
//   Agent-server → Backend → q:event tool:request → this handler
//   Handler executes JS in webview via evalWithResult → sends q:tool_response back via WS

import { match } from "ts-pattern";
import { useEffect, useCallback, useRef } from "react";
import { invoke, listen, BROWSER_PAGE_LOAD, BROWSER_URL_CHANGE } from "@/platform/tauri";
import { getErrorMessage } from "@shared/lib/errors";
import { evalWithResult } from "./eval-with-result";
import {
  SNAPSHOT_JS,
  CONSOLE_MESSAGES_JS,
  NETWORK_REQUESTS_JS,
  buildClickJs,
  buildTypeJs,
  buildWaitForTextJs,
  buildWaitForTextGoneJs,
  buildHoverJs,
  buildPressKeyJs,
  buildSelectOptionJs,
  buildEvaluateJs,
  buildScrollJs,
} from "./browser-utils";
import {
  buildMoveCursorAndRippleJs,
  buildPinCursorJs,
  HIDE_CURSOR_JS,
  buildFadeCursorJs,
  buildScreenshotFlashJs,
  SCAN_PAGE_JS,
  KEY_FLASH_JS,
} from "./visual-effects";
import type { BrowserTabState } from "../types";
import { useWsToolRequest } from "@/shared/hooks/useWsToolRequest";

/**
 * Safely parse JSON from webview evalWithResult responses.
 * Webview responses are untrusted — malformed HTML error pages, partial
 * output, or encoding issues can produce invalid JSON. This wrapper
 * throws a descriptive error instead of the raw SyntaxError.
 */
function safeParseWebviewJson<T = Record<string, unknown>>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    const preview = raw.length > 200 ? raw.slice(0, 200) + "..." : raw;
    throw new Error(`Malformed JSON from webview: ${preview}`);
  }
}

/**
 * Play a visual cursor effect (move+ripple or pin) and wait for its
 * animation duration. Non-critical — silently swallows errors so the
 * actual browser action always proceeds.
 */
async function playCursorEffect(label: string, effectJs: string): Promise<void> {
  try {
    const result = await evalWithResult(label, effectJs, 3000);
    const parsed = safeParseWebviewJson<{ duration?: number }>(result);
    if (parsed.duration && parsed.duration > 0)
      await new Promise((r) => setTimeout(r, parsed.duration));
  } catch {
    /* visual effects are non-critical */
  }
}

/**
 * Waits for the `browser:page-load` Tauri event with event="finished"
 * for the given webview label. This is emitted by Rust's `on_page_load`
 * callback — no polling needed.
 *
 * When `alsoListenUrlChange` is true (for history.back() in SPAs), also
 * resolves on `browser:url-change` since SPA routers don't trigger a
 * real page load — they fire popstate which emits url-change instead.
 *
 * After the page finishes loading, waits a short DOM-settle delay so
 * frameworks (React, Next.js, etc.) can hydrate before we snapshot.
 */
async function waitForPageLoad(
  label: string,
  timeoutMs = 15_000,
  settleMs = 500,
  alsoListenUrlChange = false
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const unlistenFns: (() => void)[] = [];

    function cleanup() {
      for (const fn of unlistenFns) fn();
    }

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error(`Page did not finish loading within ${timeoutMs}ms`));
      }
    }, timeoutMs);

    function onLoad(url: string) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        cleanup();
        // Short settle for framework hydration (React, Next.js, etc.)
        setTimeout(() => resolve(url), settleMs);
      }
    }

    // Primary: browser:page-load (real navigations)
    listen(BROWSER_PAGE_LOAD, (evt) => {
      if (evt.payload.label === label && evt.payload.event === "finished") {
        onLoad(evt.payload.url);
      }
    }).then((unlisten) => {
      unlistenFns.push(unlisten);
      if (settled) unlisten();
    });

    // Secondary: browser:url-change (SPA navigations via popstate)
    if (alsoListenUrlChange) {
      listen(BROWSER_URL_CHANGE, (evt) => {
        if (evt.payload.label === label) {
          onLoad(evt.payload.url);
        }
      }).then((unlisten) => {
        unlistenFns.push(unlisten);
        if (settled) unlisten();
      });
    }
  });
}

// ---- Response helper type ----

/** Response function for tool request handlers. */
type RespondFn = (result: unknown) => void;

/**
 * Hook that handles browser automation RPC requests from the sidecar.
 *
 * Listens for "sidecar:request" Tauri events, dispatches to the appropriate
 * handler based on method name, and sends JSON-RPC responses back to the sidecar.
 *
 * @param getActiveTab - Function to get the current active browser tab state
 * @param onAutoCreateTab - Optional callback to auto-create a browser tab when
 *   BrowserNavigate is called with no existing tab. Returns the new webviewLabel
 *   or null if creation failed. Navigate auto-creates a tab if none exists.
 * @param getTabs - Optional function to get all browser tabs for session-mapped lookups
 */
export function useBrowserRpcHandler(
  getActiveTab: () => BrowserTabState | null,
  onAutoCreateTab?: (url: string) => string | null,
  workspaceId?: string | null,
  getTabs?: () => BrowserTabState[]
) {
  const getActiveTabRef = useRef(getActiveTab);
  const getTabsRef = useRef(getTabs);
  const onAutoCreateTabRef = useRef(onAutoCreateTab);

  useEffect(() => {
    getActiveTabRef.current = getActiveTab;
  }, [getActiveTab]);

  useEffect(() => {
    getTabsRef.current = getTabs;
  }, [getTabs]);

  useEffect(() => {
    onAutoCreateTabRef.current = onAutoCreateTab;
  }, [onAutoCreateTab]);

  // Guard against rapid duplicate auto-create calls
  const autoCreatePendingRef = useRef<string | null>(null);

  // Session → webviewLabel mapping for multi-agent tab isolation.
  // Each session (agent) navigates to its own tab; subsequent operations
  // (snapshot, click, type, waitFor) target that session's tab automatically.
  const sessionTabMapRef = useRef(new Map<string, string>());

  // Clear session→tab map on workspace switch
  const prevWorkspaceIdRef = useRef(workspaceId);
  useEffect(() => {
    if (prevWorkspaceIdRef.current === workspaceId) return;
    sessionTabMapRef.current.clear();
    autoCreatePendingRef.current = null;
    prevWorkspaceIdRef.current = workspaceId;
  }, [workspaceId]);

  const resolveWebviewLabel = useCallback(
    (requestedLabel?: string, sessionId?: string): string | null => {
      if (requestedLabel) return requestedLabel;
      // Check session→tab mapping first (multi-agent isolation)
      if (sessionId) {
        const mapped = sessionTabMapRef.current.get(sessionId);
        if (mapped) return mapped;
      }
      const tab = getActiveTabRef.current();
      return tab?.webviewLabel ?? null;
    },
    []
  );

  const handleBrowserSnapshot = useCallback(
    async (params: Record<string, unknown>, respond: RespondFn) => {
      const label = resolveWebviewLabel(
        params.webviewLabel as string | undefined,
        params.sessionId as string | undefined
      );
      if (!label) {
        respond({ error: "No active browser tab" });
        return;
      }

      try {
        // Visual feedback: scan-line to show the AI is reading the page (best-effort, fire-and-forget)
        invoke("eval_browser_webview", { label, js: SCAN_PAGE_JS }).catch(() => {});

        // Heavy pages (e.g. portals) can have 10k+ DOM nodes — the
        // accessibility tree builder needs more time than the default 8s.
        const t0 = Date.now();
        const resultStr = await evalWithResult(label, SNAPSHOT_JS, 15_000);
        const result = safeParseWebviewJson(resultStr);
        console.log(`[BrowserRPC] Snapshot completed in ${Date.now() - t0}ms`);
        respond(result);
      } catch (err: unknown) {
        // Clear stale session mapping so next BrowserNavigate triggers auto-create
        const msg = getErrorMessage(err);
        if (msg.includes("not found") && params.sessionId) {
          sessionTabMapRef.current.delete(params.sessionId as string);
        }
        console.error(`[BrowserRPC] Snapshot failed:`, msg);
        respond({
          error: msg.includes("not found")
            ? "Browser tab not found. Use BrowserNavigate to open a page first."
            : msg,
        });
      }
    },
    [resolveWebviewLabel]
  );

  const handleBrowserClick = useCallback(
    async (params: Record<string, unknown>, respond: RespondFn) => {
      const label = resolveWebviewLabel(
        params.webviewLabel as string | undefined,
        params.sessionId as string | undefined
      );
      if (!label) {
        respond({ success: false, error: "No active browser tab" });
        return;
      }

      const ref = params.ref as string;
      const doubleClick = params.doubleClick as boolean | undefined;
      if (!ref) {
        respond({ success: false, error: "Missing ref parameter" });
        return;
      }

      try {
        await playCursorEffect(label, buildMoveCursorAndRippleJs(ref));

        const js = buildClickJs(ref, doubleClick);
        const resultStr = await evalWithResult(label, js);
        const result = safeParseWebviewJson(resultStr);

        // Fade cursor out gracefully after click (dwell 600ms then fade)
        invoke("eval_browser_webview", { label, js: buildFadeCursorJs() }).catch(() => {});

        respond(result);
      } catch (err: unknown) {
        respond({ success: false, error: getErrorMessage(err) });
      }
    },
    [resolveWebviewLabel]
  );

  const handleBrowserType = useCallback(
    async (params: Record<string, unknown>, respond: RespondFn) => {
      const label = resolveWebviewLabel(
        params.webviewLabel as string | undefined,
        params.sessionId as string | undefined
      );
      if (!label) {
        respond({ success: false, error: "No active browser tab" });
        return;
      }

      const ref = params.ref as string;
      const text = params.text as string;
      const submit = params.submit as boolean | undefined;
      const slowly = params.slowly as boolean | undefined;
      if (!ref || text === undefined) {
        respond({ success: false, error: "Missing ref or text parameter" });
        return;
      }

      try {
        await playCursorEffect(label, buildPinCursorJs(ref));

        const js = buildTypeJs(ref, text, submit, slowly);
        const resultStr = await evalWithResult(label, js);
        const result = safeParseWebviewJson(resultStr);

        // Unpin cursor after typing completes (best-effort)
        invoke("eval_browser_webview", { label, js: HIDE_CURSOR_JS }).catch(() => {});

        respond(result);
      } catch (err: unknown) {
        respond({ success: false, error: getErrorMessage(err) });
      }
    },
    [resolveWebviewLabel]
  );

  const handleBrowserNavigate = useCallback(
    async (params: Record<string, unknown>, respond: RespondFn) => {
      const sessionId = params.sessionId as string | undefined;
      let label = resolveWebviewLabel(params.webviewLabel as string | undefined, sessionId);

      const url = params.url as string;
      if (!url) {
        respond({ success: false, error: "Missing url parameter" });
        return;
      }

      // Check if the active tab actually has a native webview.
      // BrowserPanel always creates a default empty "New Tab" which has a
      // webviewLabel in React state but NO native WKWebView (no URL loaded).
      // In that case, we route through auto-create to populate the empty tab.
      if (label && !params.webviewLabel) {
        const tab = getActiveTabRef.current();
        if (tab && !tab.currentUrl) {
          label = null; // Empty tab → treat as no-tab for auto-create
        }
      }

      // Auto-create (or populate empty tab) if no usable webview exists
      if (!label) {
        const autoCreate = onAutoCreateTabRef.current;
        if (!autoCreate) {
          respond({ success: false, error: "No active browser tab" });
          return;
        }

        // Reuse pending auto-create if one is already in flight
        if (autoCreatePendingRef.current) {
          label = autoCreatePendingRef.current;
        } else {
          const newLabel = autoCreate(url);
          if (!newLabel) {
            respond({ success: false, error: "Failed to create browser tab" });
            return;
          }
          autoCreatePendingRef.current = newLabel;
          label = newLabel;
        }

        // Register session→tab mapping for multi-agent isolation
        if (sessionId) {
          sessionTabMapRef.current.set(sessionId, label);
        }

        try {
          // Wait for React to render BrowserTab → create webview → page finish
          const t0 = Date.now();
          const loadedUrl = await waitForPageLoad(label);
          console.log(
            `[BrowserRPC] Navigate (auto-create) → page loaded in ${Date.now() - t0}ms: ${loadedUrl}`
          );
          autoCreatePendingRef.current = null;

          // Take a snapshot of the loaded page (best-effort: heavy pages
          // may not be ready for DOM traversal immediately after loading).
          // If snapshot fails, still report success — the page loaded and
          // the agent can use BrowserSnapshot later.
          try {
            const resultStr = await evalWithResult(label, SNAPSHOT_JS, 12_000);
            const result = safeParseWebviewJson(resultStr);
            respond({ success: true, webviewLabel: label, ...result });
          } catch (snapErr: unknown) {
            const snapMsg = getErrorMessage(snapErr);
            console.warn(`[BrowserRPC] Post-navigate snapshot failed: ${snapMsg}`);
            respond({
              success: true,
              webviewLabel: label,
              snapshot: `Page loaded but snapshot failed: ${snapMsg}. Use BrowserSnapshot to retry.`,
            });
          }
        } catch (err: unknown) {
          autoCreatePendingRef.current = null;
          const msg = getErrorMessage(err);
          console.error(`[BrowserRPC] Auto-create navigation failed:`, msg);
          respond({
            success: false,
            error: msg,
          });
        }
        return;
      }

      // Register session→tab mapping for multi-agent isolation
      if (sessionId) {
        sessionTabMapRef.current.set(sessionId, label);
      }

      try {
        const t0 = Date.now();
        await invoke("navigate_browser_webview", { label, url });
        // Wait for page to finish loading (event-based, not polling)
        const loadedUrl = await waitForPageLoad(label);
        console.log(
          `[BrowserRPC] Navigate (existing tab) → page loaded in ${Date.now() - t0}ms: ${loadedUrl}`
        );
        // Take a snapshot (best-effort — heavy pages may timeout)
        try {
          const resultStr = await evalWithResult(label, SNAPSHOT_JS, 12_000);
          const result = safeParseWebviewJson(resultStr);
          respond({ success: true, webviewLabel: label, ...result });
        } catch (snapErr: unknown) {
          const snapMsg = getErrorMessage(snapErr);
          console.warn(`[BrowserRPC] Post-navigate snapshot failed: ${snapMsg}`);
          respond({
            success: true,
            webviewLabel: label,
            snapshot: `Page loaded but snapshot failed: ${snapMsg}. Use BrowserSnapshot to retry.`,
          });
        }
      } catch (err: unknown) {
        // If the webview no longer exists (stale mapping from previous session
        // or workspace switch), clear the mapping and retry via auto-create.
        const msg = getErrorMessage(err);
        const isStale = msg.includes("not found");
        if (isStale && sessionId) {
          console.warn(
            `[BrowserRPC] Stale webview '${label}', clearing mapping and retrying via auto-create`
          );
          sessionTabMapRef.current.delete(sessionId);

          const autoCreate = onAutoCreateTabRef.current;
          if (autoCreate) {
            const newLabel = autoCreate(url);
            if (newLabel) {
              sessionTabMapRef.current.set(sessionId, newLabel);
              try {
                const loadedUrl = await waitForPageLoad(newLabel);
                console.log(`[BrowserRPC] Navigate (auto-create after stale) → ${loadedUrl}`);
                try {
                  const resultStr = await evalWithResult(newLabel, SNAPSHOT_JS, 12_000);
                  const result = safeParseWebviewJson(resultStr);
                  respond({ success: true, webviewLabel: newLabel, ...result });
                } catch {
                  respond({
                    success: true,
                    webviewLabel: newLabel,
                    snapshot: "Page loaded. Use BrowserSnapshot to inspect.",
                  });
                }
                return;
              } catch (retryErr: unknown) {
                console.error(
                  `[BrowserRPC] Auto-create retry also failed:`,
                  getErrorMessage(retryErr)
                );
              }
            }
          }
        }

        console.error(`[BrowserRPC] Navigation failed:`, msg);
        respond({ success: false, error: msg });
      }
    },
    [resolveWebviewLabel]
  );

  const handleBrowserGetState = useCallback(
    async (params: Record<string, unknown>, respond: RespondFn) => {
      const tab = getActiveTabRef.current();
      if (!tab) {
        respond({
          available: false,
          hint: "Use BrowserNavigate to auto-create a tab",
        });
        return;
      }

      // If this session has a mapped tab, return that tab's info
      const sessionId = params.sessionId as string | undefined;
      const mappedLabel = sessionId ? sessionTabMapRef.current.get(sessionId) : null;

      // Find the correct tab to return state for
      let targetTab = tab;
      if (mappedLabel && mappedLabel !== tab.webviewLabel && getTabsRef.current) {
        const allTabs = getTabsRef.current();
        const mappedTab = allTabs.find((t) => t.webviewLabel === mappedLabel);
        if (mappedTab) {
          targetTab = mappedTab;
        }
      }

      respond({
        available: true,
        activeTab: {
          webviewLabel: targetTab.webviewLabel,
          url: targetTab.currentUrl || targetTab.url,
          title: targetTab.title,
        },
      });
    },
    []
  );

  const handleBrowserWaitFor = useCallback(
    async (params: Record<string, unknown>, respond: RespondFn) => {
      const label = resolveWebviewLabel(
        params.webviewLabel as string | undefined,
        params.sessionId as string | undefined
      );
      if (!label) {
        respond({ success: false, error: "No active browser tab" });
        return;
      }

      const text = params.text as string | undefined;
      const textGone = params.textGone as string | undefined;
      const time = params.time as number | undefined;
      const timeout = params.timeout as number | undefined;
      const timeoutMs = (timeout ?? 30) * 1000;

      // Validate: exactly one of text, textGone, or time must be provided
      const modeCount = [text, textGone, time].filter((v) => v !== undefined).length;
      if (modeCount === 0) {
        respond({
          success: false,
          error: "Provide one of: text, textGone, or time",
        });
        return;
      }
      if (modeCount > 1) {
        respond({
          success: false,
          error: "Provide only one of: text, textGone, or time",
        });
        return;
      }

      try {
        if (time !== undefined) {
          // Fixed wait — sleep then snapshot
          await new Promise((r) => setTimeout(r, time * 1000));
          const resultStr = await evalWithResult(label, SNAPSHOT_JS, 15_000);
          const result = safeParseWebviewJson(resultStr);
          respond({ success: true, ...result });
        } else {
          // Text polling — evalWithResult timeout = page timeout + 5s buffer
          const evalTimeout = timeoutMs + 5000;
          const js =
            text !== undefined
              ? buildWaitForTextJs(text, timeoutMs)
              : buildWaitForTextGoneJs(textGone!, timeoutMs);
          const resultStr = await evalWithResult(label, js, evalTimeout);
          const result = safeParseWebviewJson(resultStr);
          respond(result);
        }
      } catch (err: unknown) {
        respond({
          success: false,
          error: getErrorMessage(err),
        });
      }
    },
    [resolveWebviewLabel]
  );

  const handleBrowserEvaluate = useCallback(
    async (params: Record<string, unknown>, respond: RespondFn) => {
      const label = resolveWebviewLabel(
        params.webviewLabel as string | undefined,
        params.sessionId as string | undefined
      );
      if (!label) {
        respond({ error: "No active browser tab" });
        return;
      }

      const code = params.code as string;
      const ref = params.ref as string | undefined;
      if (!code) {
        respond({ error: "Missing code parameter" });
        return;
      }

      try {
        const js = buildEvaluateJs(code, ref);
        // User code may run expensive operations — 15s timeout (same as snapshot)
        const resultStr = await evalWithResult(label, js, 15_000);
        const result = safeParseWebviewJson(resultStr);
        respond(result);
      } catch (err: unknown) {
        respond({ error: getErrorMessage(err) });
      }
    },
    [resolveWebviewLabel]
  );

  const handleBrowserPressKey = useCallback(
    async (params: Record<string, unknown>, respond: RespondFn) => {
      const label = resolveWebviewLabel(
        params.webviewLabel as string | undefined,
        params.sessionId as string | undefined
      );
      if (!label) {
        respond({ success: false, error: "No active browser tab" });
        return;
      }

      const key = params.key as string;
      if (!key) {
        respond({ success: false, error: "Missing key parameter" });
        return;
      }

      try {
        // Visual feedback: highlight the focused element receiving the key (best-effort, fire-and-forget)
        invoke("eval_browser_webview", { label, js: KEY_FLASH_JS }).catch(() => {});

        const modifiers = {
          ctrl: params.ctrl as boolean | undefined,
          shift: params.shift as boolean | undefined,
          alt: params.alt as boolean | undefined,
          meta: params.meta as boolean | undefined,
        };
        const js = buildPressKeyJs(key, modifiers);
        const resultStr = await evalWithResult(label, js);
        const result = safeParseWebviewJson(resultStr);
        respond(result);
      } catch (err: unknown) {
        respond({ success: false, error: getErrorMessage(err) });
      }
    },
    [resolveWebviewLabel]
  );

  const handleBrowserHover = useCallback(
    async (params: Record<string, unknown>, respond: RespondFn) => {
      const label = resolveWebviewLabel(
        params.webviewLabel as string | undefined,
        params.sessionId as string | undefined
      );
      if (!label) {
        respond({ success: false, error: "No active browser tab" });
        return;
      }

      const ref = params.ref as string;
      if (!ref) {
        respond({ success: false, error: "Missing ref parameter" });
        return;
      }

      try {
        await playCursorEffect(label, buildMoveCursorAndRippleJs(ref));

        const js = buildHoverJs(ref);
        const resultStr = await evalWithResult(label, js);
        const result = safeParseWebviewJson(resultStr);

        // Fade cursor out gracefully after hover (dwell 600ms then fade)
        invoke("eval_browser_webview", { label, js: buildFadeCursorJs() }).catch(() => {});

        respond(result);
      } catch (err: unknown) {
        respond({ success: false, error: getErrorMessage(err) });
      }
    },
    [resolveWebviewLabel]
  );

  const handleBrowserSelectOption = useCallback(
    async (params: Record<string, unknown>, respond: RespondFn) => {
      const label = resolveWebviewLabel(
        params.webviewLabel as string | undefined,
        params.sessionId as string | undefined
      );
      if (!label) {
        respond({ success: false, error: "No active browser tab" });
        return;
      }

      const ref = params.ref as string;
      const values = params.values as string[];
      if (!ref || !values) {
        respond({ success: false, error: "Missing ref or values parameter" });
        return;
      }

      try {
        await playCursorEffect(label, buildMoveCursorAndRippleJs(ref));

        const js = buildSelectOptionJs(ref, values);
        const resultStr = await evalWithResult(label, js);
        const result = safeParseWebviewJson(resultStr);

        // Fade cursor out gracefully after select (dwell 600ms then fade)
        invoke("eval_browser_webview", { label, js: buildFadeCursorJs() }).catch(() => {});

        respond(result);
      } catch (err: unknown) {
        respond({ success: false, error: getErrorMessage(err) });
      }
    },
    [resolveWebviewLabel]
  );

  const handleBrowserNavigateBack = useCallback(
    async (params: Record<string, unknown>, respond: RespondFn) => {
      const label = resolveWebviewLabel(
        params.webviewLabel as string | undefined,
        params.sessionId as string | undefined
      );
      if (!label) {
        respond({ success: false, error: "No active browser tab" });
        return;
      }

      try {
        const t0 = Date.now();
        // Execute history.back() in the webview
        await invoke("eval_browser_webview", { label, js: "history.back();" });
        // Wait for page load OR SPA url-change (SPAs don't trigger real page loads)
        const loadedUrl = await waitForPageLoad(label, 15_000, 500, true);
        console.log(
          `[BrowserRPC] NavigateBack → page loaded in ${Date.now() - t0}ms: ${loadedUrl}`
        );
        // Take a snapshot of the new page
        try {
          const resultStr = await evalWithResult(label, SNAPSHOT_JS, 12_000);
          const result = safeParseWebviewJson(resultStr);
          respond({ success: true, ...result });
        } catch (snapErr: unknown) {
          const snapMsg = getErrorMessage(snapErr);
          console.warn(`[BrowserRPC] Post-navigateBack snapshot failed: ${snapMsg}`);
          respond({
            success: true,
            snapshot: `Navigated back but snapshot failed: ${snapMsg}. Use BrowserSnapshot to retry.`,
          });
        }
      } catch (err: unknown) {
        const msg = getErrorMessage(err);
        console.error(`[BrowserRPC] NavigateBack failed:`, msg);
        respond({ success: false, error: msg });
      }
    },
    [resolveWebviewLabel]
  );

  const handleBrowserConsoleMessages = useCallback(
    async (params: Record<string, unknown>, respond: RespondFn) => {
      const label = resolveWebviewLabel(
        params.webviewLabel as string | undefined,
        params.sessionId as string | undefined
      );
      if (!label) {
        respond({ logs: "", count: 0, error: "No active browser tab" });
        return;
      }

      try {
        const resultStr = await evalWithResult(label, CONSOLE_MESSAGES_JS);
        const result = safeParseWebviewJson(resultStr);
        respond(result);
      } catch (err: unknown) {
        respond({ logs: "", count: 0, error: getErrorMessage(err) });
      }
    },
    [resolveWebviewLabel]
  );

  const handleBrowserScreenshot = useCallback(
    async (params: Record<string, unknown>, respond: RespondFn) => {
      const label = resolveWebviewLabel(
        params.webviewLabel as string | undefined,
        params.sessionId as string | undefined
      );
      if (!label) {
        respond({ image: "", error: "No active browser tab" });
        return;
      }

      try {
        // Build optional crop rect for Rust command
        const rect = params.rect as
          | { x: number; y: number; width: number; height: number }
          | undefined;
        const invokeArgs: Record<string, unknown> = { label };
        if (rect) {
          invokeArgs.rectX = rect.x;
          invokeArgs.rectY = rect.y;
          invokeArgs.rectWidth = rect.width;
          invokeArgs.rectHeight = rect.height;
        }

        // Call the native Rust command (WKWebView.takeSnapshot on macOS)
        const base64 = await invoke<string>("screenshot_browser_webview", invokeArgs);

        // Visual feedback: camera flash effect AFTER capture (so it doesn't appear in the image)
        invoke("eval_browser_webview", {
          label,
          js: buildScreenshotFlashJs(rect ?? undefined),
        }).catch(() => {});
        // Best-effort URL + title for context
        const url = await invoke<string>("get_browser_webview_url", { label }).catch(() => "");
        respond({ image: base64, url, title: "" });
      } catch (err: unknown) {
        // Clear stale session mapping so next BrowserNavigate triggers auto-create
        const msg = getErrorMessage(err);
        if (msg.includes("not found") && params.sessionId) {
          sessionTabMapRef.current.delete(params.sessionId as string);
        }
        respond({
          image: "",
          error: msg.includes("not found")
            ? "Browser tab not found. Use BrowserNavigate to open a page first."
            : msg,
        });
      }
    },
    [resolveWebviewLabel]
  );

  const handleBrowserNetworkRequests = useCallback(
    async (params: Record<string, unknown>, respond: RespondFn) => {
      const label = resolveWebviewLabel(
        params.webviewLabel as string | undefined,
        params.sessionId as string | undefined
      );
      if (!label) {
        respond({ requests: "", count: 0, error: "No active browser tab" });
        return;
      }

      try {
        const resultStr = await evalWithResult(label, NETWORK_REQUESTS_JS);
        const result = safeParseWebviewJson(resultStr);
        respond(result);
      } catch (err: unknown) {
        respond({ requests: "", count: 0, error: getErrorMessage(err) });
      }
    },
    [resolveWebviewLabel]
  );

  const handleBrowserScroll = useCallback(
    async (params: Record<string, unknown>, respond: RespondFn) => {
      const label = resolveWebviewLabel(
        params.webviewLabel as string | undefined,
        params.sessionId as string | undefined
      );
      if (!label) {
        respond({ success: false, error: "No active browser tab" });
        return;
      }

      const direction = params.direction as string | undefined;
      const amount = params.amount as number | undefined;
      const ref = params.ref as string | undefined;

      try {
        const js = buildScrollJs(direction, amount, ref);
        const resultStr = await evalWithResult(label, js);
        const result = safeParseWebviewJson(resultStr);
        respond(result);
      } catch (err: unknown) {
        respond({ success: false, error: getErrorMessage(err) });
      }
    },
    [resolveWebviewLabel]
  );

  // ============================================================================
  // Dispatch helper
  // ============================================================================

  const dispatchBrowserMethod = useCallback(
    (
      method: string,
      params: Record<string, unknown>,
      respond: RespondFn,
      respondError?: (error: string) => void
    ) => {
      match(method)
        .with("browserSnapshot", () => handleBrowserSnapshot(params, respond))
        .with("browserClick", () => handleBrowserClick(params, respond))
        .with("browserType", () => handleBrowserType(params, respond))
        .with("browserNavigate", () => handleBrowserNavigate(params, respond))
        .with("browserGetState", () => handleBrowserGetState(params, respond))
        .with("browserWaitFor", () => handleBrowserWaitFor(params, respond))
        .with("browserEvaluate", () => handleBrowserEvaluate(params, respond))
        .with("browserPressKey", () => handleBrowserPressKey(params, respond))
        .with("browserHover", () => handleBrowserHover(params, respond))
        .with("browserSelectOption", () => handleBrowserSelectOption(params, respond))
        .with("browserNavigateBack", () => handleBrowserNavigateBack(params, respond))
        .with("browserConsoleMessages", () => handleBrowserConsoleMessages(params, respond))
        .with("browserNetworkRequests", () => handleBrowserNetworkRequests(params, respond))
        .with("browserScreenshot", () => handleBrowserScreenshot(params, respond))
        .with("browserScroll", () => handleBrowserScroll(params, respond))
        .otherwise(() => {
          if (method.startsWith("browser") && respondError) {
            respondError(`Unknown browser method: ${method}`);
          }
        });
    },
    [
      handleBrowserSnapshot,
      handleBrowserClick,
      handleBrowserType,
      handleBrowserNavigate,
      handleBrowserGetState,
      handleBrowserWaitFor,
      handleBrowserEvaluate,
      handleBrowserPressKey,
      handleBrowserHover,
      handleBrowserSelectOption,
      handleBrowserNavigateBack,
      handleBrowserConsoleMessages,
      handleBrowserNetworkRequests,
      handleBrowserScreenshot,
      handleBrowserScroll,
    ]
  );

  // ============================================================================
  // WS event listener (agent-server → backend → q:event tool:request)
  // ============================================================================

  useWsToolRequest((method, requestId, params, respond, respondError) => {
    if (import.meta.env.DEV) {
      console.log("[BrowserRPC] Received request (WS):", method, "requestId:", requestId);
    }

    dispatchBrowserMethod(method, params, respond, respondError);
  });
}
