// src/features/browser/automation/browser-utils.ts
// Re-exports the compiled browser utils IIFE + builder functions.
//
// The source TypeScript lives in inject/browser-utils.ts with full IDE support.
// It's compiled by build-inject.ts (esbuild) into dist-inject/browser-utils.js.
//
// To modify browser utilities, edit inject/browser-utils.ts and
// run `bun run build:inject` to recompile.
//
// Builder functions stay here because they're TypeScript functions that
// parameterize small runtime snippets — not worth extracting.
//
// KEY CHANGE: BROWSER_UTILS (~390 lines) was previously string-interpolated
// into every builder call. Now it's injected ONCE on page load via
// BROWSER_UTILS_SETUP, and builders reference window.__opendevsBrowserUtils.

/** The IIFE string to eval in WKWebView — installs browser utils on window.__opendevsBrowserUtils. */
import BROWSER_UTILS_SETUP from "./dist-inject/browser-utils.js?raw";
export { BROWSER_UTILS_SETUP };

// Shorthand preamble for builder functions — verifies utils are loaded.
const OPENDEVS = `var opendevs = window.__opendevsBrowserUtils;
if (!opendevs) return JSON.stringify({ success: false, error: 'Browser utils not initialized' });`;

/**
 * JS code to capture a page snapshot.
 * Returns: { snapshot: string, url: string, title: string }
 */
export const SNAPSHOT_JS = `(function(){
${OPENDEVS}
var tree = opendevs.buildPageSnapshot();
var yaml = opendevs.accessibilityTreeToYaml(tree, 0);
return JSON.stringify({
  snapshot: yaml,
  url: window.location.href,
  title: document.title
});
})()`;

/**
 * JS code to click an element by ref. Takes params via template.
 */
export function buildClickJs(ref: string, doubleClick?: boolean): string {
  return `(function(){
${OPENDEVS}
var el = opendevs.findElementByRef(${JSON.stringify(ref)});
if (!el) {
  return JSON.stringify({ success: false, error: 'Element not found: ' + ${JSON.stringify(ref)} });
}
var urlBefore = window.location.href;
opendevs.simulateClick(el, { doubleClick: ${!!doubleClick} });
return opendevs.waitForDomSettle(150, 2000).then(function() {
  // Double-settle for SPA navigation: if URL changed after first settle,
  // the framework is likely still fetching data before rendering the new page.
  // Wait a second round to catch the post-data-fetch re-render.
  if (window.location.href !== urlBefore) {
    return opendevs.waitForDomSettle(150, 3000);
  }
}).then(function() {
  var tree = opendevs.buildPageSnapshot();
  var yaml = opendevs.accessibilityTreeToYaml(tree, 0);
  return JSON.stringify({ success: true, snapshot: yaml, url: window.location.href, title: document.title });
});
})()`;
}

/**
 * JS code to type text into an element by ref.
 */
export function buildTypeJs(ref: string, text: string, submit?: boolean, slowly?: boolean): string {
  return `(function(){
${OPENDEVS}
var el = opendevs.findElementByRef(${JSON.stringify(ref)});
if (!el) {
  return JSON.stringify({ success: false, error: 'Element not found: ' + ${JSON.stringify(ref)} });
}
opendevs.simulateType(el, ${JSON.stringify(text)}, { submit: ${!!submit} });
return opendevs.waitForDomSettle(150, 2000).then(function() {
  var tree = opendevs.buildPageSnapshot();
  var yaml = opendevs.accessibilityTreeToYaml(tree, 0);
  return JSON.stringify({ success: true, snapshot: yaml, url: window.location.href, title: document.title });
});
})()`;
}

/**
 * JS code that polls until text appears on the page.
 * Returns a Promise — evalWithResult's Promise-aware wrapper handles it.
 * On success, takes a snapshot and returns { success: true, snapshot, url, title }.
 * On timeout, returns { success: false, error: "..." }.
 */
export function buildWaitForTextJs(
  text: string,
  timeoutMs: number = 30000,
  intervalMs: number = 500
): string {
  return `(function(){
${OPENDEVS}
return new Promise(function(resolve) {
  var deadline = Date.now() + ${timeoutMs};
  var searchText = ${JSON.stringify(text)};
  function poll() {
    var bodyText = document.body.innerText || '';
    if (bodyText.indexOf(searchText) !== -1) {
      var tree = opendevs.buildPageSnapshot();
      var yaml = opendevs.accessibilityTreeToYaml(tree, 0);
      resolve(JSON.stringify({
        success: true, snapshot: yaml,
        url: window.location.href, title: document.title
      }));
    } else if (Date.now() >= deadline) {
      resolve(JSON.stringify({
        success: false,
        error: 'Timed out waiting for text: ' + searchText
      }));
    } else {
      setTimeout(poll, ${intervalMs});
    }
  }
  poll();
});
})()`;
}

/**
 * JS code that polls until text disappears from the page.
 * Same Promise-based pattern as buildWaitForTextJs.
 */
export function buildWaitForTextGoneJs(
  text: string,
  timeoutMs: number = 30000,
  intervalMs: number = 500
): string {
  return `(function(){
${OPENDEVS}
return new Promise(function(resolve) {
  var deadline = Date.now() + ${timeoutMs};
  var searchText = ${JSON.stringify(text)};
  function poll() {
    var bodyText = document.body.innerText || '';
    if (bodyText.indexOf(searchText) === -1) {
      var tree = opendevs.buildPageSnapshot();
      var yaml = opendevs.accessibilityTreeToYaml(tree, 0);
      resolve(JSON.stringify({
        success: true, snapshot: yaml,
        url: window.location.href, title: document.title
      }));
    } else if (Date.now() >= deadline) {
      resolve(JSON.stringify({
        success: false,
        error: 'Timed out waiting for text to disappear: ' + searchText
      }));
    } else {
      setTimeout(poll, ${intervalMs});
    }
  }
  poll();
});
})()`;
}

/**
 * JS code to hover over an element by ref.
 * Dispatches mouseenter → mouseover → mousemove at element center.
 * Returns snapshot after hover (so agent can see tooltip/menu changes).
 */
export function buildHoverJs(ref: string): string {
  return `(function(){
${OPENDEVS}
var el = opendevs.findElementByRef(${JSON.stringify(ref)});
if (!el) {
  return JSON.stringify({ success: false, error: 'Element not found: ' + ${JSON.stringify(ref)} });
}
opendevs.scrollIntoViewIfNeeded(el);
var center = opendevs.getElementCenter(el);
var opts = {
  bubbles: true, cancelable: true, view: window,
  clientX: center.x, clientY: center.y,
  button: 0, buttons: 0
};
el.dispatchEvent(new MouseEvent('mouseenter', Object.assign({}, opts, { bubbles: false })));
el.dispatchEvent(new MouseEvent('mouseover', opts));
el.dispatchEvent(new MouseEvent('mousemove', opts));
return opendevs.waitForDomSettle(150, 2000).then(function() {
  var tree = opendevs.buildPageSnapshot();
  var yaml = opendevs.accessibilityTreeToYaml(tree, 0);
  return JSON.stringify({ success: true, snapshot: yaml, url: window.location.href, title: document.title });
});
})()`;
}

/**
 * JS code to press a key. Dispatches keydown → keyup (keypress omitted — deprecated).
 * Supports modifier keys: ctrlKey, shiftKey, altKey, metaKey.
 * Special handling for scroll keys (ArrowUp/Down, PageUp/Down, Home, End, Space).
 * For Enter on a focused input, also submits the enclosing form.
 */
export function buildPressKeyJs(
  key: string,
  modifiers?: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean }
): string {
  const ctrl = modifiers?.ctrl ?? false;
  const shift = modifiers?.shift ?? false;
  const alt = modifiers?.alt ?? false;
  const meta = modifiers?.meta ?? false;

  // PressKey doesn't need browser utils (no snapshot, no element finder).
  // It operates on document.activeElement directly.
  return `(function(){
  var key = ${JSON.stringify(key)};
  var target = document.activeElement || document.body;

  // Map key names to KeyboardEvent properties
  var keyMap = {
    'Enter': { key: 'Enter', code: 'Enter', keyCode: 13 },
    'Tab': { key: 'Tab', code: 'Tab', keyCode: 9 },
    'Escape': { key: 'Escape', code: 'Escape', keyCode: 27 },
    'Backspace': { key: 'Backspace', code: 'Backspace', keyCode: 8 },
    'Delete': { key: 'Delete', code: 'Delete', keyCode: 46 },
    'ArrowUp': { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    'ArrowDown': { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    'ArrowLeft': { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    'ArrowRight': { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    'PageUp': { key: 'PageUp', code: 'PageUp', keyCode: 33 },
    'PageDown': { key: 'PageDown', code: 'PageDown', keyCode: 34 },
    'Home': { key: 'Home', code: 'Home', keyCode: 36 },
    'End': { key: 'End', code: 'End', keyCode: 35 },
    'Space': { key: ' ', code: 'Space', keyCode: 32 },
    ' ': { key: ' ', code: 'Space', keyCode: 32 },
    'F1': { key: 'F1', code: 'F1', keyCode: 112 },
    'F2': { key: 'F2', code: 'F2', keyCode: 113 },
    'F3': { key: 'F3', code: 'F3', keyCode: 114 },
    'F4': { key: 'F4', code: 'F4', keyCode: 115 },
    'F5': { key: 'F5', code: 'F5', keyCode: 116 },
    'F6': { key: 'F6', code: 'F6', keyCode: 117 },
    'F7': { key: 'F7', code: 'F7', keyCode: 118 },
    'F8': { key: 'F8', code: 'F8', keyCode: 119 },
    'F9': { key: 'F9', code: 'F9', keyCode: 120 },
    'F10': { key: 'F10', code: 'F10', keyCode: 121 },
    'F11': { key: 'F11', code: 'F11', keyCode: 122 },
    'F12': { key: 'F12', code: 'F12', keyCode: 123 }
  };

  var mapped = keyMap[key] || { key: key, code: 'Key' + key.toUpperCase(), keyCode: key.charCodeAt(0) };
  var eventOpts = {
    bubbles: true, cancelable: true, view: window,
    key: mapped.key, code: mapped.code, keyCode: mapped.keyCode, which: mapped.keyCode,
    ctrlKey: ${ctrl}, shiftKey: ${shift}, altKey: ${alt}, metaKey: ${meta}
  };

  target.dispatchEvent(new KeyboardEvent('keydown', eventOpts));
  target.dispatchEvent(new KeyboardEvent('keyup', eventOpts));

  // Scroll keys — simulate scroll behavior (only without modifiers)
  if (!${ctrl} && !${alt} && !${meta}) {
    var scrollKeys = { ArrowUp: -40, ArrowDown: 40, PageUp: -400, PageDown: 400,
                       Home: -999999, End: 999999, ' ': 300 };
    if (scrollKeys[mapped.key] !== undefined) {
      window.scrollBy(0, scrollKeys[mapped.key]);
    }
  }

  // Enter on input — submit enclosing form (only without modifiers)
  if (mapped.key === 'Enter' && !${ctrl} && !${meta} && target.tagName && target.tagName.toLowerCase() === 'input') {
    var form = target.closest('form');
    if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
  }

  return JSON.stringify({ success: true });
})();
`;
}

/**
 * JS code to select option(s) in a <select> element.
 * Clears existing selections, applies new ones, dispatches input+change events.
 * Returns snapshot after selection.
 */
export function buildSelectOptionJs(ref: string, values: string[]): string {
  return `(function(){
${OPENDEVS}
var el = opendevs.findElementByRef(${JSON.stringify(ref)});
if (!el) {
  return JSON.stringify({ success: false, error: 'Element not found: ' + ${JSON.stringify(ref)} });
}
if (el.tagName.toLowerCase() !== 'select') {
  return JSON.stringify({ success: false, error: 'Element is not a <select>: ' + el.tagName });
}
var targetValues = ${JSON.stringify(values)};
for (var i = 0; i < el.options.length; i++) {
  el.options[i].selected = false;
}
var matched = 0;
for (var i = 0; i < el.options.length; i++) {
  var opt = el.options[i];
  for (var j = 0; j < targetValues.length; j++) {
    if (opt.value === targetValues[j] || opt.text === targetValues[j]) {
      opt.selected = true;
      matched++;
      break;
    }
  }
}
el.dispatchEvent(new Event('input', { bubbles: true }));
el.dispatchEvent(new Event('change', { bubbles: true }));
return opendevs.waitForDomSettle(150, 2000).then(function() {
  var tree = opendevs.buildPageSnapshot();
  var yaml = opendevs.accessibilityTreeToYaml(tree, 0);
  return JSON.stringify({ success: true, matched: matched, snapshot: yaml, url: window.location.href, title: document.title });
});
})()`;
}

/**
 * JS code that evaluates user-provided JavaScript in page context.
 * If a ref is provided, the element is passed as the first argument.
 * Returns the stringified result + snapshot.
 *
 * Promise-aware: if user code returns a thenable (async result),
 * the wrapper awaits it before capturing the snapshot. This enables
 * `return fetch('/api').then(r => r.json())` and similar patterns.
 * evalWithResult's Promise-aware wrapper handles the outer Promise.
 */
export function buildEvaluateJs(jsCode: string, ref?: string): string {
  const finalize = `
  function __finalize(result) {
    var resultStr = result === undefined ? 'undefined' : JSON.stringify(result, null, 2);
    var tree = opendevs.buildPageSnapshot();
    var yaml = opendevs.accessibilityTreeToYaml(tree, 0);
    return JSON.stringify({ result: resultStr, snapshot: yaml });
  }`;

  if (ref) {
    return `(function(){
${OPENDEVS}
${finalize}
var el = opendevs.findElementByRef(${JSON.stringify(ref)});
if (!el) return JSON.stringify({ error: 'Element not found: ' + ${JSON.stringify(ref)} });
try {
  var fn = new Function('element', ${JSON.stringify(jsCode)});
  var result = fn(el);
  if (result && typeof result === 'object' && typeof result.then === 'function') {
    return result.then(function(v) { return __finalize(v); }, function(e) {
      return JSON.stringify({ error: e.message || String(e) });
    });
  }
  return __finalize(result);
} catch(e) {
  return JSON.stringify({ error: e.message || String(e) });
}
})()`;
  }
  return `(function(){
${OPENDEVS}
${finalize}
try {
  var fn = new Function(${JSON.stringify(jsCode)});
  var result = fn();
  if (result && typeof result === 'object' && typeof result.then === 'function') {
    return result.then(function(v) { return __finalize(v); }, function(e) {
      return JSON.stringify({ error: e.message || String(e) });
    });
  }
  return __finalize(result);
} catch(e) {
  return JSON.stringify({ error: e.message || String(e) });
}
})()`;
}

/**
 * JS code to scroll the page by direction/amount, or scroll an element
 * into view by ref. After scrolling, waits for DOM settle then returns
 * a fresh snapshot so the AI gets updated refs.
 *
 * @param direction - "up" | "down" | "left" | "right"
 * @param amount - pixels to scroll (default 600 — roughly one viewport)
 * @param ref - optional element ref to scroll into view instead of direction-scroll
 */
export function buildScrollJs(direction?: string, amount?: number, ref?: string): string {
  const px = amount ?? 600;

  if (ref) {
    // Scroll element into view, then snapshot
    return `(function(){
${OPENDEVS}
var el = opendevs.findElementByRef(${JSON.stringify(ref)});
if (!el) {
  return JSON.stringify({ success: false, error: 'Element not found: ' + ${JSON.stringify(ref)} });
}
el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
return opendevs.waitForDomSettle(150, 2000).then(function() {
  var tree = opendevs.buildPageSnapshot();
  var yaml = opendevs.accessibilityTreeToYaml(tree, 0);
  return JSON.stringify({ success: true, snapshot: yaml, url: window.location.href, title: document.title });
});
})()`;
  }

  // Direction-based scroll
  const scrollMap: Record<string, string> = {
    up: `window.scrollBy(0, -${px})`,
    down: `window.scrollBy(0, ${px})`,
    left: `window.scrollBy(-${px}, 0)`,
    right: `window.scrollBy(${px}, 0)`,
  };
  const scrollCmd = scrollMap[direction ?? "down"] ?? scrollMap["down"];

  return `(function(){
${OPENDEVS}
${scrollCmd};
return opendevs.waitForDomSettle(150, 2000).then(function() {
  var tree = opendevs.buildPageSnapshot();
  var yaml = opendevs.accessibilityTreeToYaml(tree, 0);
  return JSON.stringify({ success: true, snapshot: yaml, url: window.location.href, title: document.title });
});
})()`;
}

// ========================================================================
// BrowserConsoleMessages — read captured console output
// ========================================================================

/**
 * JS code to read the console log buffer captured by the initialization script.
 * Returns formatted log entries (level, message, timestamp).
 * The buffer is NOT cleared — use drain_browser_console for that.
 */
export const CONSOLE_MESSAGES_JS = `
(function() {
  var logs = window.__OPENDEVS_LOGS__ || [];
  var entries = logs.map(function(l) {
    return '[' + (l.l || 'info').toUpperCase() + '] ' + (l.m || '');
  });
  return JSON.stringify({
    logs: entries.join('\\n'),
    count: logs.length
  });
})();
`;

// ========================================================================
// BrowserNetworkRequests — read network activity via Performance API
// ========================================================================

/**
 * JS code to read network requests via the Performance Resource Timing API.
 * Returns request URLs, methods, and timing info.
 * This captures resources loaded by the page (scripts, stylesheets, XHR, fetch).
 */
export const NETWORK_REQUESTS_JS = `
(function() {
  var entries = performance.getEntriesByType('resource');
  var requests = entries.map(function(e) {
    var type = e.initiatorType || 'other';
    var duration = Math.round(e.duration);
    var size = e.transferSize ? Math.round(e.transferSize / 1024) + 'KB' : '?';
    return '[' + type.toUpperCase() + '] ' + e.name + ' (' + duration + 'ms, ' + size + ')';
  });
  return JSON.stringify({
    requests: requests.join('\\n'),
    count: entries.length
  });
})();
`;
