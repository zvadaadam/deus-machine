// src/features/browser/automation/inspect-mode.ts
// Re-exports the inspect mode IIFE for WKWebView injection.
//
// The source lives in inject/inspect-mode.js — a plain JavaScript IIFE
// imported directly via Vite's ?raw suffix. No build step required.

/** The IIFE string to eval in WKWebView — sets up inspect mode infrastructure. */
import INSPECT_MODE_SETUP from "./inject/inspect-mode.js?raw";
export { INSPECT_MODE_SETUP };

/** Enable inspect mode (call after INSPECT_MODE_SETUP has been eval'd) */
export const INSPECT_MODE_ENABLE = `(function(){
  if (window.__opendevsInspect) {
    window.__opendevsInspect.enable();
  } else {
    console.error('[opendevs-inspect] ENABLE FAILED: window.__opendevsInspect is undefined');
  }
})()`;

/** Disable inspect mode */
export const INSPECT_MODE_DISABLE = `(function(){
  if (window.__opendevsInspect) window.__opendevsInspect.disable();
})()`;

/** Check if inspect mode is active */
export const INSPECT_MODE_IS_ACTIVE = `(function(){
  return JSON.stringify({ active: window.__opendevsInspect ? window.__opendevsInspect.isActive() : false });
})()`;

/** Verify that the inspect mode IIFE completed and installed the public API.
 *  Returns JSON with status flags. Used after eval'ing INSPECT_MODE_SETUP
 *  to confirm it didn't silently fail (fire-and-forget eval can't detect
 *  JS runtime errors). */
export const INSPECT_MODE_VERIFY = `(function(){
  return JSON.stringify({
    opendevsInspect: !!window.__opendevsInspect,
    hasDrainEvents: !!(window.__opendevsInspect && window.__opendevsInspect.drainEvents),
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
  if (window.__opendevsInspect && window.__opendevsInspect.drainEvents) {
    return window.__opendevsInspect.drainEvents();
  }
  return '[]';
})()`;
