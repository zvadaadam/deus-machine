// src/features/browser/automation/inspect-mode.ts
// Re-exports the compiled inspect mode IIFE for WKWebView injection.
//
// The source TypeScript lives in inject/inspect-mode.ts with full IDE support
// (syntax highlighting, type checking, autocomplete). It's compiled by
// build-inject.ts (esbuild) into dist-inject/inspect-mode.js as a self-
// contained IIFE. This file imports that compiled output as a raw string.
//
// To modify the inspect mode behavior, edit inject/inspect-mode.ts and
// run `bun run build:inject` to recompile.

/** The IIFE string to eval in WKWebView — sets up inspect mode infrastructure. */
import INSPECT_MODE_SETUP from './dist-inject/inspect-mode.js?raw';
export { INSPECT_MODE_SETUP };

/** Enable inspect mode (call after INSPECT_MODE_SETUP has been eval'd) */
export const INSPECT_MODE_ENABLE = `(function(){
  if (window.__hiveInspect) {
    window.__hiveInspect.enable();
  } else {
    console.error('[hive-inspect] ENABLE FAILED: window.__hiveInspect is undefined');
  }
})()`;

/** Disable inspect mode */
export const INSPECT_MODE_DISABLE = `(function(){
  if (window.__hiveInspect) window.__hiveInspect.disable();
})()`;

/** Check if inspect mode is active */
export const INSPECT_MODE_IS_ACTIVE = `(function(){
  return JSON.stringify({ active: window.__hiveInspect ? window.__hiveInspect.isActive() : false });
})()`;

/** Verify that the inspect mode IIFE completed and installed the public API.
 *  Returns JSON with status flags. Used after eval'ing INSPECT_MODE_SETUP
 *  to confirm it didn't silently fail (fire-and-forget eval can't detect
 *  JS runtime errors). */
export const INSPECT_MODE_VERIFY = `(function(){
  return JSON.stringify({
    hiveInspect: !!window.__hiveInspect,
    hasDrainEvents: !!(window.__hiveInspect && window.__hiveInspect.drainEvents),
  });
})()`;

/**
 * Drain buffered inspect events from the WKWebView.
 *
 * Returns a JSON string: Array<{ type: string; data: unknown }>
 * where type is "element-event" or "selection-mode".
 *
 * Uses eval_browser_webview_with_result (native completion handler)
 * instead of the title-channel, avoiding collision with console drain.
 */
export const INSPECT_MODE_DRAIN_EVENTS = `(function(){
  if (window.__hiveInspect && window.__hiveInspect.drainEvents) {
    return window.__hiveInspect.drainEvents();
  }
  return '[]';
})()`;
