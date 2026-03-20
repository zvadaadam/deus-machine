// src/features/browser/automation/eval-with-result.ts
// Evaluates JavaScript in an Electron BrowserView and captures the return value
// via Electron's executeJavaScript API.
//
// Architecture:
// 1. Wraps JS code in error-handling IIFE that returns a string result
// 2. Calls eval_browser_webview (Electron → BrowserView.executeJavaScript)
// 3. Electron resolves the JS result via its internal completion handler
// 4. IPC returns the result directly to TypeScript
//
// For Promise-based results (e.g. BrowserWaitFor polling), the wrapper stores
// the result in a global variable and returns a sentinel. TypeScript then polls
// for the resolved value using separate eval calls.
//
// Previous approach used document.title as a side-channel, but WKWebView's
// multi-process architecture coalesces rapid title changes, causing the
// title-channel message to be silently dropped 100% of the time.

import { native } from "@/platform";

// Sentinel returned when JS produces a Promise result that needs async resolution
const ASYNC_SENTINEL = "__OPENDEVS_ASYNC__";

let evalCounter = 0;

/**
 * Execute JavaScript in a webview and capture the result.
 *
 * The JS code must evaluate to a value (typically a JSON.stringify() call).
 * Uses WKWebView's native evaluateJavaScript:completionHandler: for reliable
 * result capture.
 *
 * @param label - Webview label (identifies which browser tab)
 * @param js - JavaScript code that evaluates to a string (JSON.stringify result)
 * @param timeoutMs - Timeout in milliseconds (default: 8000)
 * @returns The string result from the JS evaluation
 */
export async function evalWithResult(
  label: string,
  js: string,
  timeoutMs: number = 8000
): Promise<string> {
  const requestId = `eval-${++evalCounter}-${Date.now()}`;

  // Wrap the JS code to:
  // 1. Evaluate the user's JS expression in a try/catch
  // 2. If the result is synchronous, return it directly as a string
  // 3. If the result is a Promise (e.g. BrowserWaitFor), store it in a
  //    global variable for polling and return ASYNC_SENTINEL
  // IMPORTANT: All JS templates MUST be single expressions (typically IIFEs).
  // Do NOT use `(function(){ return ${js} })()` — that triggers JS Automatic
  // Semicolon Insertion when ${js} starts with a newline, silently returning
  // undefined. Using `var __result = ${js}` is safe because `=` always expects
  // an expression (no ASI after assignment operator).
  const wrappedJs = `(function(){
    try {
      var __result = ${js};
      if (__result && typeof __result === 'object' && typeof __result.then === 'function') {
        window.__opendevs_pending = window.__opendevs_pending || {};
        window.__opendevs_pending['${requestId}'] = {done: false};
        __result.then(function(v) {
          window.__opendevs_pending['${requestId}'] = {done: true, value: typeof v === 'string' ? v : String(v)};
        }, function(e) {
          window.__opendevs_pending['${requestId}'] = {done: true, error: e.message || String(e)};
        });
        return '${ASYNC_SENTINEL}';
      }
      return typeof __result === 'string' ? __result : String(__result);
    } catch(__e) {
      return JSON.stringify({error: __e.message || String(__e)});
    }
  })()`;

  // Call the native executeJavaScript via Electron IPC
  const result = await native.browserViews.evaluateWithResult(label, wrappedJs, timeoutMs);
  if (result === null) {
    throw new Error("evalWithResult: browser view not available");
  }

  // Synchronous result — return directly
  if (result !== ASYNC_SENTINEL) {
    return result;
  }

  // Async result (Promise) — poll for the resolved value
  return pollAsyncResult(label, requestId, timeoutMs);
}

/**
 * Poll for an async (Promise-based) result stored in a global variable.
 * Used for BrowserWaitFor and other tools that return Promises.
 */
async function pollAsyncResult(
  label: string,
  requestId: string,
  timeoutMs: number
): Promise<string> {
  const pollJs = `(function(){
    var p = window.__opendevs_pending && window.__opendevs_pending['${requestId}'];
    if (!p) return JSON.stringify({done: false});
    if (p.done) {
      delete window.__opendevs_pending['${requestId}'];
      return p.error
        ? JSON.stringify({error: p.error})
        : (typeof p.value === 'string' ? p.value : String(p.value));
    }
    return JSON.stringify({done: false});
  })()`;

  const startTime = Date.now();
  const pollInterval = 200; // ms

  while (Date.now() - startTime < timeoutMs) {
    await new Promise((r) => setTimeout(r, pollInterval));

    try {
      const result = await native.browserViews.evaluateWithResult(label, pollJs, 5000);
      if (result === null) continue;

      // Check if still pending
      try {
        const parsed = JSON.parse(result);
        if (parsed.done === false) continue;
        if (parsed.error) return result; // Return the error JSON
      } catch {
        // Not JSON — it's the actual resolved value
      }

      return result;
    } catch {
      // Eval failed (webview might be navigating) — keep polling
      continue;
    }
  }

  // Clean up the pending entry
  native.browserViews
    .evaluate(label, `delete (window.__opendevs_pending || {})['${requestId}']`)
    .catch(() => {});

  throw new Error(
    `evalWithResult async result timed out after ${timeoutMs}ms (requestId: ${requestId})`
  );
}
