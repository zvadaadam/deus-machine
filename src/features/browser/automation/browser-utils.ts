// src/features/browser/automation/browser-utils.ts
// JavaScript code that executes INSIDE the webview to build accessibility trees,
// simulate clicks, type text, and interact with page elements.
//
// Architecture: These are string constants containing JS code. The frontend
// wraps them in eval calls via Tauri's eval_browser_webview_with_result command.
// Results are returned directly via WKWebView's evaluateJavaScript:completionHandler:.
//
// Ported from Cursor's BROWSER_UTILS pattern with enhancements from mcp-dev-browser.

/**
 * Core utility functions injected into every browser automation call.
 * Includes: accessibility tree builder, element finder, event helpers.
 *
 * ~400 lines of self-contained JS with no external dependencies.
 */
export const BROWSER_UTILS = `
// ========================================================================
// Accessibility Tree Builder (ported from Cursor's browser automation)
// ========================================================================

function getTextFromIds(ids) {
  if (!ids) return '';
  return ids.split(' ').map(function(id) {
    var el = document.getElementById(id);
    return el ? (el.textContent || '').trim() : '';
  }).filter(Boolean).join(' ');
}

function getVisibleText(el) {
  try {
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: function(node) {
        var parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        var style = window.getComputedStyle(parent);
        if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var text = '';
    while (walker.nextNode()) {
      text += ' ' + walker.currentNode.textContent;
      if (text.length > 200) break;
    }
    return text.replace(/\\s+/g, ' ').trim().substring(0, 200);
  } catch(e) {
    var raw = el.innerText || el.textContent || '';
    return raw.replace(/\\s+/g, ' ').trim().substring(0, 200);
  }
}

function getLabelsText(el) {
  try {
    if (!el.labels || !el.labels.length) return '';
    return Array.from(el.labels).map(function(l) {
      return getVisibleText(l);
    }).filter(Boolean).join(' ').substring(0, 200);
  } catch(e) { return ''; }
}

function getImplicitRole(el) {
  var tag = el.tagName.toLowerCase();
  switch(tag) {
    case 'a': return el.hasAttribute('href') ? 'link' : 'generic';
    case 'button': case 'summary': return 'button';
    case 'input':
      var t = (el.type || 'text').toLowerCase();
      if (t === 'button' || t === 'submit' || t === 'reset' || t === 'image') return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'range') return 'slider';
      if (t === 'number') return 'spinbutton';
      return 'textbox';
    case 'select': return (el.multiple || (el.size && el.size > 1)) ? 'listbox' : 'combobox';
    case 'option': return 'option';
    case 'textarea': return 'textbox';
    case 'img': case 'svg': return 'img';
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading';
    case 'ul': case 'ol': return 'list';
    case 'li': return 'listitem';
    case 'nav': return 'navigation';
    case 'main': return 'main';
    case 'header': return 'banner';
    case 'footer': return 'contentinfo';
    case 'form': return 'form';
    case 'table': return 'table';
    case 'tr': return 'row';
    case 'td': return 'cell';
    case 'th': return 'columnheader';
    case 'section': return 'section';
    case 'article': return 'article';
    case 'aside': return 'aside';
    case 'details': return 'group';
    case 'progress': return 'progressbar';
    case 'meter': return 'meter';
    case 'label': return 'label';
    default: return 'generic';
  }
}

function computeAccessibleName(el, role) {
  if (el.getAttribute('aria-hidden') === 'true') return '';
  var labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) { var t = getTextFromIds(labelledBy); if (t) return t.substring(0, 200); }
  var ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel.substring(0, 200);
  var placeholder = el.getAttribute('aria-placeholder');
  if (placeholder) return placeholder.substring(0, 200);
  var labels = getLabelsText(el);
  if (labels) return labels;
  var tag = el.tagName.toLowerCase();
  if (tag === 'img') { var alt = el.getAttribute('alt'); if (alt) return alt.substring(0, 200); }
  if (tag === 'input') {
    if (['button','submit','reset'].includes((el.type||'').toLowerCase())) {
      if (el.value) return el.value.substring(0, 200);
    }
    return (el.placeholder || el.value || '').substring(0, 200);
  }
  if (tag === 'textarea') return (el.placeholder || el.value || '').substring(0, 200);
  if (tag === 'select') {
    var opts = Array.from(el.selectedOptions || []).map(function(o) { return o.text; });
    if (opts.length) return opts.join(', ').substring(0, 200);
  }
  var interactiveTags = ['button','a','h1','h2','h3','h4','h5','h6','label','p','li','summary'];
  if (interactiveTags.includes(tag) || role === 'button' || role === 'link' || role === 'heading') {
    return getVisibleText(el);
  }
  var title = el.getAttribute('title');
  if (title) return title.substring(0, 200);
  return '';
}

function collectElementStates(el, role) {
  var states = [];
  try {
    if (el.matches(':focus')) states.push('focused');
    if (el.matches(':disabled')) states.push('disabled');
    if (el.checked) states.push('checked');
    if (el.required) states.push('required');
    if (el.readOnly) states.push('readonly');
    if (el.selected) states.push('selected');
  } catch(e) {}
  var ariaStates = {
    'aria-selected': 'selected', 'aria-expanded': null, 'aria-pressed': 'pressed',
    'aria-current': 'current', 'aria-invalid': 'invalid', 'aria-busy': 'busy'
  };
  for (var attr in ariaStates) {
    var val = el.getAttribute(attr);
    if (val && val !== 'false') {
      if (attr === 'aria-expanded') states.push(val === 'true' ? 'expanded' : 'collapsed');
      else states.push(ariaStates[attr] || attr.replace('aria-', ''));
    }
  }
  return [...new Set(states)];
}

function collectElementDetails(el, role) {
  var details = {};
  var desc = el.getAttribute('aria-description') || '';
  var descBy = el.getAttribute('aria-describedby');
  if (descBy) desc = (desc + ' ' + getTextFromIds(descBy)).trim();
  if (desc) details.description = desc.substring(0, 200);
  var tag = el.tagName.toLowerCase();
  if (tag === 'a' && el.href) details.url = el.href;
  if ((tag === 'img' || tag === 'svg') && el.src) details.src = el.src;
  if (tag === 'input' || tag === 'textarea') {
    if ((el.type || '').toLowerCase() !== 'password') {
      if (el.value) details.value = el.value.substring(0, 200);
    }
    if (el.placeholder) details.placeholder = el.placeholder.substring(0, 200);
  }
  if (tag === 'select') {
    var opts = Array.from(el.selectedOptions || []).map(function(o) { return o.text; });
    if (opts.length) details.value = opts.join(', ').substring(0, 200);
  }
  return details;
}

function shouldIncludeElement(el) {
  if (el.getAttribute('aria-hidden') === 'true') return false;
  var tag = el.tagName.toLowerCase();
  var includeTags = ['a','button','input','select','textarea','img','svg',
    'h1','h2','h3','h4','h5','h6','nav','main','header','footer',
    'section','article','form','label','ul','ol','li','p','summary','details'];
  if (includeTags.includes(tag)) return true;
  var role = el.getAttribute('role');
  if (role && role !== 'generic' && role !== 'presentation' && role !== 'none') return true;
  if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) return true;
  if (el.contentEditable === 'true') return true;
  if (el.querySelector('a,button,input,select,textarea')) return true;
  return false;
}

// Global node counter — caps traversal to prevent timeouts on heavy pages.
// Reset before each snapshot; shared across recursive calls.
var __nodeCount = 0;
var __NODE_LIMIT = 3000;

function buildAccessibilityTree(element, depth, maxDepth) {
  if (depth > maxDepth || __nodeCount >= __NODE_LIMIT) return null;
  __nodeCount++;
  // Assign or reuse data-cursor-ref
  var ref = element.getAttribute('data-cursor-ref');
  if (!ref) {
    ref = 'ref-' + Math.random().toString(36).substring(2, 15);
    element.setAttribute('data-cursor-ref', ref);
  }
  var role = element.getAttribute('role') || getImplicitRole(element);
  var name = computeAccessibleName(element, role);
  var states = collectElementStates(element, role);
  var details = collectElementDetails(element, role);
  var node = { ref: ref, role: role, name: name };
  // Add heading level
  var tag = element.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tag)) node.level = parseInt(tag[1]);
  if (states.length) node.states = states;
  Object.assign(node, details);
  // Recurse children (bail early if node limit reached)
  var children = [];
  for (var i = 0; i < element.children.length && __nodeCount < __NODE_LIMIT; i++) {
    var child = element.children[i];
    if (shouldIncludeElement(child)) {
      var childNode = buildAccessibilityTree(child, depth + 1, maxDepth);
      if (childNode) children.push(childNode);
    }
  }
  if (children.length) node.children = children;
  return node;
}

function buildPageSnapshot() {
  __nodeCount = 0;
  return buildAccessibilityTree(document.body, 0, 20);
}

// ========================================================================
// YAML Formatter (token-efficient output for AI consumption)
// ========================================================================

function accessibilityTreeToYaml(node, indent) {
  indent = indent || 0;
  if (!node) return '';
  var pad = '  '.repeat(indent);
  var lines = [];
  lines.push(pad + '- role: ' + node.role);
  if (node.name) {
    var escaped = /[:"\\[]/.test(node.name) ? '"' + node.name.replace(/"/g, '\\\\"') + '"' : node.name;
    lines.push(pad + '  name: ' + escaped);
  }
  lines.push(pad + '  ref: ' + node.ref);
  if (node.level) lines.push(pad + '  level: ' + node.level);
  if (node.states && node.states.length) lines.push(pad + '  states: [' + node.states.join(', ') + ']');
  if (node.url) lines.push(pad + '  url: ' + node.url);
  if (node.value) lines.push(pad + '  value: ' + node.value);
  if (node.placeholder) lines.push(pad + '  placeholder: ' + node.placeholder);
  if (node.description) lines.push(pad + '  description: ' + node.description);
  if (node.children && node.children.length) {
    lines.push(pad + '  children:');
    for (var i = 0; i < node.children.length; i++) {
      lines.push(accessibilityTreeToYaml(node.children[i], indent + 2));
    }
  }
  return lines.join('\\n');
}

// ========================================================================
// Element Interaction Helpers
// ========================================================================

function findElementByRef(ref) {
  return document.querySelector('[data-cursor-ref="' + ref + '"]');
}

function scrollIntoViewIfNeeded(el) {
  var rect = el.getBoundingClientRect();
  var inView = rect.top >= 0 && rect.left >= 0
    && rect.bottom <= (window.innerHeight || document.documentElement.clientHeight)
    && rect.right <= (window.innerWidth || document.documentElement.clientWidth);
  if (!inView) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
}

function getElementCenter(el) {
  var rect = el.getBoundingClientRect();
  return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
}

function simulateClick(el, opts) {
  opts = opts || {};
  scrollIntoViewIfNeeded(el);
  var center = getElementCenter(el);
  var eventOpts = {
    bubbles: true, cancelable: true, view: window,
    button: 0, buttons: 1,
    clientX: center.x, clientY: center.y,
    ctrlKey: false, shiftKey: false, altKey: false, metaKey: false
  };
  el.focus();
  el.dispatchEvent(new MouseEvent('mousedown', eventOpts));
  el.dispatchEvent(new MouseEvent('mouseup', eventOpts));
  el.dispatchEvent(new MouseEvent('click', eventOpts));
  if (opts.doubleClick) {
    el.dispatchEvent(new MouseEvent('mousedown', eventOpts));
    el.dispatchEvent(new MouseEvent('mouseup', eventOpts));
    el.dispatchEvent(new MouseEvent('click', eventOpts));
    el.dispatchEvent(new MouseEvent('dblclick', eventOpts));
  }
}

function simulateType(el, text, opts) {
  opts = opts || {};
  scrollIntoViewIfNeeded(el);
  el.focus();
  if (el.contentEditable === 'true') {
    el.textContent = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    // Use the native value setter to bypass React's internal value tracker.
    // React intercepts el.value = X but only fires onChange if its tracker
    // sees a change. Setting via the prototype setter updates the tracker.
    var nativeSetter = Object.getOwnPropertyDescriptor(
      el.tagName.toLowerCase() === 'textarea'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype,
      'value'
    );
    if (nativeSetter && nativeSetter.set) {
      nativeSetter.set.call(el, text);
    } else {
      el.value = text;
    }
    // Dispatch InputEvent (not just Event) with data + inputType for
    // framework compatibility (React, Vue, Angular all check these).
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true, cancelable: true,
      data: text, inputType: 'insertText'
    }));
  }
  el.dispatchEvent(new Event('change', { bubbles: true }));
  if (opts.submit) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    var form = el.closest && el.closest('form');
    if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
  }
}

// ========================================================================
// DOM Settle — wait for DOM to stop changing after an action
// ========================================================================
// Uses MutationObserver to detect a "quiet period" where no DOM mutations
// occur. This ensures SPA frameworks (React, Next.js, Vue) have finished
// re-rendering after a click/type/hover before we capture the snapshot.
//
// Parameters:
//   quietMs — ms of silence required to consider DOM settled (default: 150)
//   maxMs   — hard cap to prevent infinite waiting (default: 2000)

function waitForDomSettle(quietMs, maxMs) {
  quietMs = quietMs || 150;
  maxMs = maxMs || 2000;
  return new Promise(function(resolve) {
    var timer = null;
    var maxTimer = null;
    var observer = new MutationObserver(function() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function() {
        observer.disconnect();
        if (maxTimer) clearTimeout(maxTimer);
        resolve();
      }, quietMs);
    });
    observer.observe(document.body, {
      childList: true, subtree: true, attributes: true, characterData: true
    });
    // Start quiet timer immediately (resolves if no mutations at all)
    timer = setTimeout(function() {
      observer.disconnect();
      resolve();
    }, quietMs);
    // Hard cap: always resolve by maxMs
    maxTimer = setTimeout(function() {
      observer.disconnect();
      if (timer) clearTimeout(timer);
      resolve();
    }, maxMs);
  });
}
`;

/**
 * JS code to capture a page snapshot. Prepends BROWSER_UTILS.
 * Returns: { snapshot: string, url: string, title: string }
 */
export const SNAPSHOT_JS = `(function(){
${BROWSER_UTILS}
var tree = buildPageSnapshot();
var yaml = accessibilityTreeToYaml(tree, 0);
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
${BROWSER_UTILS}
var el = findElementByRef(${JSON.stringify(ref)});
if (!el) {
  return JSON.stringify({ success: false, error: 'Element not found: ' + ${JSON.stringify(ref)} });
}
var urlBefore = window.location.href;
simulateClick(el, { doubleClick: ${!!doubleClick} });
return waitForDomSettle(150, 2000).then(function() {
  // Double-settle for SPA navigation: if URL changed after first settle,
  // the framework is likely still fetching data before rendering the new page.
  // Wait a second round to catch the post-data-fetch re-render.
  if (window.location.href !== urlBefore) {
    return waitForDomSettle(150, 3000);
  }
}).then(function() {
  var tree = buildPageSnapshot();
  var yaml = accessibilityTreeToYaml(tree, 0);
  return JSON.stringify({ success: true, snapshot: yaml, url: window.location.href, title: document.title });
});
})()`;
}

/**
 * JS code to type text into an element by ref.
 */
export function buildTypeJs(ref: string, text: string, submit?: boolean, slowly?: boolean): string {
  return `(function(){
${BROWSER_UTILS}
var el = findElementByRef(${JSON.stringify(ref)});
if (!el) {
  return JSON.stringify({ success: false, error: 'Element not found: ' + ${JSON.stringify(ref)} });
}
simulateType(el, ${JSON.stringify(text)}, { submit: ${!!submit} });
return waitForDomSettle(150, 2000).then(function() {
  var tree = buildPageSnapshot();
  var yaml = accessibilityTreeToYaml(tree, 0);
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
${BROWSER_UTILS}
return new Promise(function(resolve) {
  var deadline = Date.now() + ${timeoutMs};
  var searchText = ${JSON.stringify(text)};
  function poll() {
    var bodyText = document.body.innerText || '';
    if (bodyText.indexOf(searchText) !== -1) {
      var tree = buildPageSnapshot();
      var yaml = accessibilityTreeToYaml(tree, 0);
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
${BROWSER_UTILS}
return new Promise(function(resolve) {
  var deadline = Date.now() + ${timeoutMs};
  var searchText = ${JSON.stringify(text)};
  function poll() {
    var bodyText = document.body.innerText || '';
    if (bodyText.indexOf(searchText) === -1) {
      var tree = buildPageSnapshot();
      var yaml = accessibilityTreeToYaml(tree, 0);
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

// ========================================================================
// BrowserHover — dispatch hover events on an element
// ========================================================================

/**
 * JS code to hover over an element by ref.
 * Dispatches mouseenter → mouseover → mousemove at element center.
 * Returns snapshot after hover (so agent can see tooltip/menu changes).
 */
export function buildHoverJs(ref: string): string {
  return `(function(){
${BROWSER_UTILS}
var el = findElementByRef(${JSON.stringify(ref)});
if (!el) {
  return JSON.stringify({ success: false, error: 'Element not found: ' + ${JSON.stringify(ref)} });
}
scrollIntoViewIfNeeded(el);
var center = getElementCenter(el);
var opts = {
  bubbles: true, cancelable: true, view: window,
  clientX: center.x, clientY: center.y,
  button: 0, buttons: 0
};
el.dispatchEvent(new MouseEvent('mouseenter', Object.assign({}, opts, { bubbles: false })));
el.dispatchEvent(new MouseEvent('mouseover', opts));
el.dispatchEvent(new MouseEvent('mousemove', opts));
return waitForDomSettle(150, 2000).then(function() {
  var tree = buildPageSnapshot();
  var yaml = accessibilityTreeToYaml(tree, 0);
  return JSON.stringify({ success: true, snapshot: yaml, url: window.location.href, title: document.title });
});
})()`;
}

// ========================================================================
// BrowserPressKey — dispatch keyboard events
// ========================================================================

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

  return `(function(){
${BROWSER_UTILS}
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

// ========================================================================
// BrowserSelectOption — select dropdown values
// ========================================================================

/**
 * JS code to select option(s) in a <select> element.
 * Clears existing selections, applies new ones, dispatches input+change events.
 * Returns snapshot after selection.
 */
export function buildSelectOptionJs(ref: string, values: string[]): string {
  return `(function(){
${BROWSER_UTILS}
var el = findElementByRef(${JSON.stringify(ref)});
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
return waitForDomSettle(150, 2000).then(function() {
  var tree = buildPageSnapshot();
  var yaml = accessibilityTreeToYaml(tree, 0);
  return JSON.stringify({ success: true, matched: matched, snapshot: yaml, url: window.location.href, title: document.title });
});
})()`;
}

// ========================================================================
// BrowserEvaluate — run arbitrary JS on the page
// ========================================================================

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
    var tree = buildPageSnapshot();
    var yaml = accessibilityTreeToYaml(tree, 0);
    return JSON.stringify({ result: resultStr, snapshot: yaml });
  }`;

  if (ref) {
    return `(function(){
${BROWSER_UTILS}
${finalize}
var el = findElementByRef(${JSON.stringify(ref)});
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
${BROWSER_UTILS}
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

// ========================================================================
// BrowserScroll — scroll the page or a specific element
// ========================================================================

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
${BROWSER_UTILS}
var el = findElementByRef(${JSON.stringify(ref)});
if (!el) {
  return JSON.stringify({ success: false, error: 'Element not found: ' + ${JSON.stringify(ref)} });
}
el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
return waitForDomSettle(150, 2000).then(function() {
  var tree = buildPageSnapshot();
  var yaml = accessibilityTreeToYaml(tree, 0);
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
${BROWSER_UTILS}
${scrollCmd};
return waitForDomSettle(150, 2000).then(function() {
  var tree = buildPageSnapshot();
  var yaml = accessibilityTreeToYaml(tree, 0);
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
  var logs = window.__HIVE_LOGS__ || [];
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
