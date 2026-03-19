// src/features/browser/automation/visual-effects.ts
// Re-exports the compiled visual effects IIFE + builder functions.
//
// The source TypeScript lives in inject/visual-effects.ts with full IDE support.
// It's compiled by build-inject.ts (esbuild) into dist-inject/visual-effects.js.
//
// To modify visual effects behavior, edit inject/visual-effects.ts and
// run `bun run build:inject` to recompile.
//
// Builder functions (buildMoveCursorAndRippleJs, etc.) stay here because they're
// TypeScript functions that parameterize small runtime snippets — not worth extracting.

/** The IIFE string to eval in WKWebView — sets up visual effects infrastructure. */
import VISUAL_EFFECTS_SETUP from './dist-inject/visual-effects.js?raw';
export { VISUAL_EFFECTS_SETUP };

/**
 * Build JS to move cursor to an element by data-opendevs-ref,
 * then ripple on arrival (used before click actions).
 * Returns duration (ms) via title-channel so frontend can wait.
 */
export function buildMoveCursorAndRippleJs(ref: string): string {
  return `(function(){
  if (!window.__opendevsVisuals) return JSON.stringify({duration:0});
  var el = document.querySelector('[data-opendevs-ref="${ref}"]');
  if (!el) return JSON.stringify({duration:0, error:'Element not found'});
  var dur = window.__opendevsVisuals.moveCursorToElement(el);
  // Ripple after cursor arrives
  setTimeout(function(){
    var rect = el.getBoundingClientRect();
    var cx = Math.round(rect.left + rect.width / 2);
    var cy = Math.round(rect.top + rect.height / 2);
    window.__opendevsVisuals.rippleAt(cx, cy);
  }, dur + 20);
  return JSON.stringify({duration: dur + 280});
})()`;
}

/**
 * Build JS to move cursor to an element and pin it (for typing).
 */
export function buildPinCursorJs(ref: string): string {
  return `(function(){
  if (!window.__opendevsVisuals) return JSON.stringify({duration:0});
  var el = document.querySelector('[data-opendevs-ref="${ref}"]');
  if (!el) return JSON.stringify({duration:0, error:'Element not found'});
  var dur = window.__opendevsVisuals.moveCursorToElement(el);
  setTimeout(function(){
    window.__opendevsVisuals.pinCursorToElement(el);
  }, dur + 20);
  return JSON.stringify({duration: dur + 20});
})()`;
}

/** Build JS to unpin and hide cursor (after typing finishes) */
export const HIDE_CURSOR_JS = `(function(){
  if (window.__opendevsVisuals) window.__opendevsVisuals.hideCursor();
})()`;

/**
 * Build JS to fade cursor out gracefully after a dwell period.
 * Used after click/hover — cursor lingers so user sees where AI interacted,
 * then fades out smoothly. Default dwell: 600ms.
 */
export function buildFadeCursorJs(dwellMs = 1000): string {
  return `(function(){
  if (window.__opendevsVisuals) window.__opendevsVisuals.fadeCursor(${dwellMs});
})()`;
}

/**
 * Build JS for screenshot flash effect.
 * If rect is provided, flashes only that region; otherwise flashes full viewport.
 */
export function buildScreenshotFlashJs(rect?: {
  x: number;
  y: number;
  width: number;
  height: number;
}): string {
  const rectArg = rect
    ? `{x:${rect.x},y:${rect.y},width:${rect.width},height:${rect.height}}`
    : "null";
  return `(function(){
  if (window.__opendevsVisuals) window.__opendevsVisuals.screenshotFlash(${rectArg});
})()`;
}

/**
 * Build JS for page scan effect (thin blue line sweeps down viewport).
 * Used to show the AI is reading/scanning the page (BrowserSnapshot).
 */
export const SCAN_PAGE_JS = `(function(){
  if (window.__opendevsVisuals) window.__opendevsVisuals.scanPage();
})()`;

/**
 * Build JS for key flash effect (highlight the currently focused element).
 * Used to show the AI pressing a key on an input/element.
 */
export const KEY_FLASH_JS = `(function(){
  if (window.__opendevsVisuals) window.__opendevsVisuals.keyFlash();
})()`;

