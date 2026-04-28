// inject/inspect-mode.js
// Browser inspect/design mode — runs inside WKWebView page context.
//
// Plain JavaScript IIFE — imported directly via Vite's ?raw suffix.
// When eval'd, creates interactive element selection:
// - Hover overlay with bounding box and element label
// - Click to capture element data (selector, rect, styles, React component)
// - Drag-to-select for area screenshots
// - Custom SVG cursor replacing system cursor
// - Escape to exit
//
// Communication back to frontend via event buffer:
//   JS pushes events to window.__DEUS_INSPECT_EVENTS__ array.
//   React drains the buffer every 200ms via eval_browser_webview_with_result
//   (WKWebView's native evaluateJavaScript:completionHandler:).
//
// We do NOT use the title-channel (document.title) for inspect events —
// BROWSER_INIT_SCRIPT already uses it for SPA nav detection, and two
// independent writers on document.title causes WKWebView KVO to silently
// coalesce/drop messages. Buffer+drain is simple and 200ms is imperceptible.

(function() {
// Guard: prevent double-injection if eval'd multiple times
if (window.__deusInspectMode) return;
window.__deusInspectMode = true;

  // ========================================================================
  // State
  // ========================================================================
  var selectionMode = false;
  var overlay = null;
  var overlayLabel = null;
  var selectionCursor = null;
  var cursorStyleOverride = null;
  var isDragging = false;
  var dragStartX = 0;
  var dragStartY = 0;
  var dragSelectionBox = null;
  var elementIdCounter = 0;
  var selectionIdCounter = 0;
  // Last-clicked element — the host's prompt overlay is anchored to it, so
  // we keep the blue border painted around it instead of snapping back to
  // mouse hover. Cleared on a fresh click (updated to the new element),
  // on host-initiated clearSelection, or on disableSelectionMode.
  var pinnedElement = null;
  var pinnedSelectionKey = null;

  // ========================================================================
  // Event Buffer — sole communication path to React
  // ========================================================================
  // Events are pushed to an in-page array and drained every 200ms by the
  // React side via eval_browser_webview_with_result (native completion handler).
  // This avoids the title-channel race condition (see architecture note below).

  var eventBuffer = [];
  window.__DEUS_INSPECT_EVENTS__ = eventBuffer;

  // ARCHITECTURE NOTE — DO NOT use document.title for inspect events.
  //
  // BrowserView communication has two patterns:
  //   1. Title-channel: JS sets document.title -> page-title-updated event
  //   2. Buffer+drain:  JS pushes to array -> executeJavaScript reads it back every 200ms
  //
  // The title-channel is used by BROWSER_INIT_SCRIPT (webview.rs) for SPA nav
  // detection. Adding a second writer (this script) causes a race: WKWebView's
  // KVO coalesces rapid title changes, silently dropping messages. We tried
  // serializing with queues and delays — it's fundamentally unreliable with
  // two independent writers. Buffer+drain is simple and 200ms is imperceptible.

  function sendToFrontend(type, data) {
    eventBuffer.push({ type: type, data: data });
  }

  // ========================================================================
  // Element ID Assignment
  // ========================================================================
  // Counter-based stable element ID.
  // Monotonically increasing counter gives predictable, stable refs that
  // don't change between inspections — unlike random strings.
  function getOrAssignElementId(el) {
    var existing = el.getAttribute("data-deus-ref");
    if (existing) return existing;
    elementIdCounter++;
    var id = "deus-" + elementIdCounter;
    el.setAttribute("data-deus-ref", id);
    return id;
  }

  function createSelectionKey(ref) {
    selectionIdCounter++;
    return ref + "@" + selectionIdCounter;
  }

  // ========================================================================
  // React Fiber Detection
  // ========================================================================
  // Enhanced React fiber detection — handles ForwardRef, Memo, and
  // elementType (which preserves the original unwrapped type).

  function getReactComponentInfo(el) {
    try {
      var keys = Object.keys(el);
      var fiberKey = null;
      for (var i = 0; i < keys.length; i++) {
        if (
          keys[i].indexOf("__reactFiber") === 0 ||
          keys[i].indexOf("__reactInternalInstance") === 0
        ) {
          fiberKey = keys[i];
          break;
        }
      }
      if (!fiberKey) return { componentName: null, fileName: null, lineNumber: null };

      var fiber = el[fiberKey];
      while (fiber) {
        // Prefer elementType (original unwrapped type) over type
        var type = fiber.elementType || fiber.type;
        var compName = null;

        if (type && typeof type === "function") {
          compName = type.displayName || type.name || "Anonymous";
        } else if (type && typeof type === "object") {
          // Handle ForwardRef: { $$typeof: Symbol(react.forward_ref), render: fn }
          // Handle Memo: { $$typeof: Symbol(react.memo), type: fn }
          var symStr = type.$$typeof ? type.$$typeof.toString() : "";
          if (symStr.indexOf("forward_ref") !== -1 && type.render) {
            compName =
              type.render.displayName || type.render.name || type.displayName || "ForwardRef";
          } else if (symStr.indexOf("memo") !== -1 && type.type) {
            var inner = type.type;
            if (typeof inner === "function") {
              compName = inner.displayName || inner.name || "Memo";
            }
          }
        }

        if (compName) {
          var fileName = null;
          var lineNumber = null;
          if (fiber._debugSource) {
            fileName = fiber._debugSource.fileName;
            lineNumber = fiber._debugSource.lineNumber;
          }
          return { componentName: compName, fileName: fileName, lineNumber: lineNumber };
        }

        fiber = fiber.return;
      }
    } catch (_e) {
      /* swallow */
    }
    return { componentName: null, fileName: null, lineNumber: null };
  }

  // ========================================================================
  // Accessible Name Computation (ARIA spec priority order)
  // ========================================================================
  function computeAccessibleName(el) {
    try {
      // 1. aria-labelledby — resolve referenced IDs and join text
      var labelledBy = el.getAttribute("aria-labelledby");
      if (labelledBy) {
        var ids = labelledBy.split(/\s+/);
        var texts = [];
        for (var i = 0; i < ids.length; i++) {
          var refEl = document.getElementById(ids[i]);
          if (refEl) texts.push(refEl.textContent || "");
        }
        var joined = texts.join(" ").trim();
        if (joined) return joined;
      }
      // 2. aria-label attribute
      var ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel) return ariaLabel;
      // 3. Associated <label> via for attribute
      if (el.id) {
        var label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (label) return (label.textContent || "").trim();
      }
      // 4. placeholder (inputs)
      var ph = el.getAttribute("placeholder");
      if (ph) return ph;
      // 5. alt (images)
      var alt = el.getAttribute("alt");
      if (alt) return alt;
      // 6. title attribute
      var title = el.getAttribute("title");
      if (title) return title;
    } catch (_e) {
      /* swallow */
    }
    return null;
  }

  // ========================================================================
  // Color Conversion via Canvas API
  // ========================================================================
  // Converts modern color formats (oklch, oklab, etc.) to hex using
  // 1x1 Canvas pixel readback — the only reliable cross-browser method.
  var colorCanvas = null;
  var colorCtx = null;

  function convertColorToHex(color) {
    if (!color || color === "transparent" || color === "rgba(0, 0, 0, 0)") return null;
    if (color.charAt(0) === "#") return color;
    // Standard rgba — quick parse without canvas
    var rgbaMatch = color.match(/^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/);
    if (rgbaMatch) {
      var r = parseInt(rgbaMatch[1], 10);
      var g = parseInt(rgbaMatch[2], 10);
      var b = parseInt(rgbaMatch[3], 10);
      return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
    }
    // Modern formats (oklch, oklab, color-mix, etc.) — Canvas API fallback
    try {
      if (!colorCanvas) {
        colorCanvas = document.createElement("canvas");
        colorCanvas.width = 1;
        colorCanvas.height = 1;
        colorCtx = colorCanvas.getContext("2d");
      }
      colorCtx.clearRect(0, 0, 1, 1);
      colorCtx.fillStyle = color;
      colorCtx.fillRect(0, 0, 1, 1);
      var data = colorCtx.getImageData(0, 0, 1, 1).data;
      return "#" + ((1 << 24) + (data[0] << 16) + (data[1] << 8) + data[2]).toString(16).slice(1);
    } catch (_e) {
      return color;
    }
  }

  // ========================================================================
  // CSS var() Token Preservation
  // ========================================================================
  // Walks matched stylesheet rules to find original var(--token) declarations
  // instead of only using getComputedStyle() which resolves variables.
  // Gives the AI agent design token names instead of computed values.
  // Uses WeakMap cache with TTL for performance.
  var varDeclCache = new WeakMap();
  var VAR_CACHE_TTL = 2000;

  function getMatchedVarDeclarations(el) {
    var cached = varDeclCache.get(el);
    if (cached && Date.now() - cached.ts < VAR_CACHE_TTL) return cached.decls;

    var decls = {};
    var varScanProps = ["background-color", "color", "border-color", "padding", "gap"];
    try {
      var sheets = document.styleSheets;
      for (var si = 0; si < sheets.length; si++) {
        var rules;
        try {
          rules = sheets[si].cssRules;
        } catch (_e) {
          continue;
        } // Skip cross-origin stylesheets
        if (!rules) continue;
        for (var ri = 0; ri < rules.length; ri++) {
          var rule = rules[ri];
          if (!rule.selectorText || !rule.style) continue;
          try {
            if (!el.matches(rule.selectorText)) continue;
          } catch (_e) {
            continue;
          }
          for (var ci = 0; ci < varScanProps.length; ci++) {
            var val = rule.style.getPropertyValue(varScanProps[ci]);
            if (val && val.indexOf("var(") !== -1) {
              decls[varScanProps[ci]] = val.trim();
            }
          }
        }
      }
    } catch (_e) {
      /* swallow */
    }
    varDeclCache.set(el, { ts: Date.now(), decls: decls });
    return decls;
  }

  // ========================================================================
  // Custom SVG Cursor
  // ========================================================================
  function createSelectionCursor() {
    var svgNS = "http://www.w3.org/2000/svg";
    var cursor = document.createElementNS(svgNS, "svg");
    cursor.setAttribute("width", "16");
    cursor.setAttribute("height", "16");
    cursor.setAttribute("viewBox", "0 0 16 16");
    cursor.setAttribute("fill", "none");
    cursor.setAttribute("data-deus-inspect", "true");
    cursor.setAttribute("aria-hidden", "true");
    cursor.style.position = "fixed";
    cursor.style.pointerEvents = "none";
    cursor.style.zIndex = "2147483646";
    cursor.style.transform = "translate(-50%, -50%)";
    cursor.style.left = "-1000px";
    cursor.style.top = "-1000px";
    cursor.style.transition = "opacity 150ms ease";

    var gClip = document.createElementNS(svgNS, "g");
    gClip.setAttribute("clip-path", "url(#clip0_hive)");
    var gFilter = document.createElementNS(svgNS, "g");
    gFilter.setAttribute("filter", "url(#filter0_hive)");

    var path = document.createElementNS(svgNS, "path");
    path.setAttribute(
      "d",
      "M1.68066 2.14282C1.5253 1.49746 2.16954 0.975576 2.75195 1.21118L2.86816 1.26782L3.11035 1.41333L12.958 7.27954L13.2031 7.42505C13.8128 7.78856 13.682 8.70779 12.9951 8.88696L12.7197 8.95825L8.28223 10.1155L6.16895 13.9592L6.02148 14.2288C5.66933 14.869 4.71301 14.741 4.54199 14.0305L4.4707 13.7317L1.74707 2.41724L1.68066 2.14282Z"
    );
    path.setAttribute("fill", "black");
    path.setAttribute("stroke", "white");
    gFilter.appendChild(path);
    gClip.appendChild(gFilter);

    var defs = document.createElementNS(svgNS, "defs");
    var filter = document.createElementNS(svgNS, "filter");
    filter.setAttribute("id", "filter0_hive");
    filter.setAttribute("x", "-1.51");
    filter.setAttribute("y", "-1.35");
    filter.setAttribute("width", "18.27");
    filter.setAttribute("height", "19.83");
    filter.setAttribute("filterUnits", "userSpaceOnUse");
    filter.setAttribute("color-interpolation-filters", "sRGB");

    var feFlood = document.createElementNS(svgNS, "feFlood");
    feFlood.setAttribute("flood-opacity", "0");
    feFlood.setAttribute("result", "BackgroundImageFix");
    filter.appendChild(feFlood);
    var feCM = document.createElementNS(svgNS, "feColorMatrix");
    feCM.setAttribute("in", "SourceAlpha");
    feCM.setAttribute("type", "matrix");
    feCM.setAttribute("values", "0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0");
    feCM.setAttribute("result", "hardAlpha");
    filter.appendChild(feCM);
    var feOff = document.createElementNS(svgNS, "feOffset");
    feOff.setAttribute("dy", "0.667");
    filter.appendChild(feOff);
    var feBlur = document.createElementNS(svgNS, "feGaussianBlur");
    feBlur.setAttribute("stdDeviation", "1.333");
    filter.appendChild(feBlur);
    var feComp = document.createElementNS(svgNS, "feComposite");
    feComp.setAttribute("in2", "hardAlpha");
    feComp.setAttribute("operator", "out");
    filter.appendChild(feComp);
    var feCM2 = document.createElementNS(svgNS, "feColorMatrix");
    feCM2.setAttribute("type", "matrix");
    feCM2.setAttribute("values", "0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.5 0");
    filter.appendChild(feCM2);
    var feB1 = document.createElementNS(svgNS, "feBlend");
    feB1.setAttribute("mode", "normal");
    feB1.setAttribute("in2", "BackgroundImageFix");
    feB1.setAttribute("result", "effect1");
    filter.appendChild(feB1);
    var feB2 = document.createElementNS(svgNS, "feBlend");
    feB2.setAttribute("mode", "normal");
    feB2.setAttribute("in", "SourceGraphic");
    feB2.setAttribute("in2", "effect1");
    feB2.setAttribute("result", "shape");
    filter.appendChild(feB2);
    defs.appendChild(filter);

    var clipPath = document.createElementNS(svgNS, "clipPath");
    clipPath.setAttribute("id", "clip0_hive");
    var rect = document.createElementNS(svgNS, "rect");
    rect.setAttribute("width", "16");
    rect.setAttribute("height", "16");
    rect.setAttribute("fill", "white");
    clipPath.appendChild(rect);
    defs.appendChild(clipPath);

    cursor.appendChild(defs);
    cursor.appendChild(gClip);
    return cursor;
  }

  // ========================================================================
  // Inspect Element Helpers
  // ========================================================================
  function isInspectElement(el) {
    return !!el && !!el.getAttribute && el.getAttribute("data-deus-inspect") === "true";
  }

  /** Tailwind utility class pattern — skipped when building element paths and className */
  var TAILWIND_PATTERN =
    /^(flex|grid|p-|m-|text-|bg-|border|rounded|w-|h-|gap-|items-|justify-|overflow-|opacity-|transition|duration|ease|hover:|focus:|active:|dark:|hidden|block|inline|relative|absolute|fixed|sticky|min-|max-|space-|divide-|ring-|shadow-|sr-|not-|group|peer|placeholder-|disabled:|data-|aria-|sm:|md:|lg:|xl:|2xl:|\[|!)/;

  // ========================================================================
  // React Props Extraction
  // ========================================================================
  // Walks the React fiber to extract serializable component props.
  // Only includes primitives (string, number, boolean) and small objects.
  // Skips functions, children, refs, and internal React keys.
  var SKIP_PROP_KEYS = [
    "children",
    "ref",
    "key",
    "__self",
    "__source",
    "className",
    "style",
    "dangerouslySetInnerHTML",
  ];

  function getReactProps(el) {
    try {
      var keys = Object.keys(el);
      var fiberKey = null;
      for (var i = 0; i < keys.length; i++) {
        if (
          keys[i].indexOf("__reactFiber") === 0 ||
          keys[i].indexOf("__reactInternalInstance") === 0
        ) {
          fiberKey = keys[i];
          break;
        }
      }
      if (!fiberKey) return null;

      var fiber = el[fiberKey];
      // Walk up to find the first user component fiber (skip host elements)
      while (fiber) {
        var type = fiber.elementType || fiber.type;
        if (type && typeof type !== "string") {
          // Found a component fiber (function/class component, not a host element)
          var name =
            typeof type === "function"
              ? type.displayName || type.name
              : type.render?.displayName ||
                type.render?.name ||
                type.type?.displayName ||
                type.type?.name;
          if (name) break;
        }
        fiber = fiber.return;
      }
      if (!fiber) return null;

      var raw = fiber.memoizedProps || fiber.pendingProps;
      if (!raw || typeof raw !== "object") return null;

      var result = {};
      var totalLen = 0;
      var MAX_LEN = 500;

      for (var _k = 0, _keys = Object.keys(raw); _k < _keys.length; _k++) {
        var key = _keys[_k];
        if (totalLen >= MAX_LEN) break;
        if (SKIP_PROP_KEYS.indexOf(key) !== -1) continue;
        if (key.startsWith("on") || key.startsWith("__")) continue; // Skip event handlers and internals

        var val = raw[key];
        var t = typeof val;

        if (t === "string") {
          if (val.length > 100) continue;
          result[key] = val;
          totalLen += key.length + val.length + 3;
        } else if (t === "number" || t === "boolean") {
          var s = String(val);
          result[key] = s;
          totalLen += key.length + s.length + 3;
        } else if (val === null || val === undefined) {
          // skip nullish
        } else if (t === "object" && !Array.isArray(val)) {
          try {
            var json = JSON.stringify(val);
            if (json.length <= 80) {
              result[key] = json;
              totalLen += key.length + json.length + 3;
            }
          } catch (_) {
            /* skip non-serializable */
          }
        }
        // Skip functions, arrays, symbols
      }

      return Object.keys(result).length > 0 ? result : null;
    } catch (_e) {
      return null;
    }
  }

  // ========================================================================
  // Filtered HTML Attributes
  // ========================================================================
  // Whitelist of HTML attributes useful for AI context — identifiers, state,
  // accessibility. Skips class/style (redundant with other fields).
  var ATTR_WHITELIST = [
    "id",
    "data-testid",
    "data-test-id",
    "href",
    "src",
    "alt",
    "type",
    "name",
    "placeholder",
    "disabled",
    "checked",
    "role",
    "aria-label",
    "aria-expanded",
    "aria-hidden",
    "action",
    "for",
    "target",
    "required",
    "readonly",
    "min",
    "max",
    "pattern",
    "method",
  ];

  function getFilteredAttributes(el) {
    var result = {};
    for (var i = 0; i < ATTR_WHITELIST.length; i++) {
      var attr = ATTR_WHITELIST[i];
      var val = el.getAttribute(attr);
      if (val !== null && val !== "") {
        result[attr] = val.length > 100 ? val.substring(0, 100) : val;
      }
    }
    // Also grab data-* attrs that look like test IDs or state
    var attrs = el.attributes;
    if (attrs) {
      for (var j = 0; j < attrs.length; j++) {
        var name = attrs[j].name;
        if (
          name.startsWith("data-") &&
          !result[name] &&
          name !== "data-deus-ref" &&
          name !== "data-deus-inspect"
        ) {
          if (
            name.indexOf("test") !== -1 ||
            name.indexOf("state") !== -1 ||
            name.indexOf("variant") !== -1 ||
            name.indexOf("status") !== -1
          ) {
            result[name] = attrs[j].value.substring(0, 100);
          }
        }
      }
    }
    return Object.keys(result).length > 0 ? result : null;
  }

  // ========================================================================
  // Shallow innerHTML
  // ========================================================================
  // Captures element's inner HTML structure capped at 500 chars.
  // Gives the AI structural context (icon + text, list items, input groups).
  function getShallowInnerHTML(el) {
    try {
      var html = el.innerHTML;
      if (!html || html.length === 0) return null;
      if (html.length <= 500) return html.trim();
      // Truncate, try to break at a tag boundary
      var truncated = html.substring(0, 500);
      var lastClose = truncated.lastIndexOf(">");
      if (lastClose > 400) truncated = truncated.substring(0, lastClose + 1);
      return truncated.trim() + "...";
    } catch (_e) {
      return null;
    }
  }

  // ========================================================================
  // Enable / Disable Selection Mode
  // ========================================================================
  function enableSelectionMode() {
    if (selectionMode) return;
    selectionMode = true;
    pinnedElement = null;
    pinnedSelectionKey = null;
    document.body.style.cursor = "none";

    if (!cursorStyleOverride) {
      cursorStyleOverride = document.createElement("style");
      cursorStyleOverride.textContent = "* { cursor: none !important; }";
      document.head.appendChild(cursorStyleOverride);
    }

    if (!selectionCursor) {
      selectionCursor = createSelectionCursor();
      document.body.appendChild(selectionCursor);
    }

    if (!overlay) {
      overlay = document.createElement("div");
      overlay.setAttribute("data-deus-inspect", "true");
      overlay.style.cssText =
        "position:fixed;background:rgba(58,150,221,0.3);border:2px solid #3a96dd;pointer-events:none;z-index:2147483647;transition:all 0.1s ease;display:none;";
      document.body.appendChild(overlay);

      overlayLabel = document.createElement("div");
      overlayLabel.setAttribute("data-deus-inspect", "true");
      overlayLabel.style.cssText =
        "position:fixed;background:#3a96dd;color:white;padding:2px 6px;font-size:11px;font-family:system-ui,-apple-system,sans-serif;font-weight:500;border-radius:2px;pointer-events:none;z-index:2147483648;transition:all 0.1s ease;white-space:nowrap;display:none;";
      document.body.appendChild(overlayLabel);
    }

    document.addEventListener("mousedown", handleMouseDown, true);
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp, true);
    document.addEventListener("click", handleClick, true);
    document.addEventListener("keydown", handleKeyDown, true);

    sendToFrontend("selection-mode", { active: true });
  }

  function disableSelectionMode() {
    if (!selectionMode) return;
    selectionMode = false;
    pinnedElement = null;
    pinnedSelectionKey = null;
    document.body.style.cursor = "";

    if (cursorStyleOverride) {
      cursorStyleOverride.remove();
      cursorStyleOverride = null;
    }
    if (selectionCursor) {
      selectionCursor.remove();
      selectionCursor = null;
    }
    if (overlay) {
      overlay.remove();
      overlay = null;
    }
    if (overlayLabel) {
      overlayLabel.remove();
      overlayLabel = null;
    }
    if (dragSelectionBox) {
      dragSelectionBox.remove();
      dragSelectionBox = null;
    }

    document.removeEventListener("mousedown", handleMouseDown, true);
    document.removeEventListener("mousemove", handleMouseMove);
    document.removeEventListener("mouseup", handleMouseUp, true);
    document.removeEventListener("click", handleClick, true);
    document.removeEventListener("keydown", handleKeyDown, true);

    sendToFrontend("selection-mode", { active: false });
  }

  // ========================================================================
  // Event Handlers
  // ========================================================================
  function handleMouseDown(e) {
    if (!selectionMode) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;

    if (overlay) overlay.style.display = "none";
    if (overlayLabel) overlayLabel.style.display = "none";
    // Hide cursor during click/drag so elementFromPoint doesn't hit it
    if (selectionCursor) selectionCursor.style.display = "none";

    if (!dragSelectionBox) {
      dragSelectionBox = document.createElement("div");
      dragSelectionBox.setAttribute("data-deus-inspect", "true");
      dragSelectionBox.style.cssText =
        "position:fixed;background:rgba(58,150,221,0.1);border:2px dashed #3a96dd;pointer-events:none;z-index:2147483647;";
      document.body.appendChild(dragSelectionBox);
    }
    dragSelectionBox.style.left = dragStartX + "px";
    dragSelectionBox.style.top = dragStartY + "px";
    dragSelectionBox.style.width = "0px";
    dragSelectionBox.style.height = "0px";
  }

  function handleMouseMove(e) {
    if (!selectionMode) return;

    if (selectionCursor) {
      selectionCursor.style.left = e.clientX + "px";
      selectionCursor.style.top = e.clientY + "px";
    }

    if (isDragging && dragSelectionBox) {
      var left = Math.min(dragStartX, e.clientX);
      var top = Math.min(dragStartY, e.clientY);
      var width = Math.abs(e.clientX - dragStartX);
      var height = Math.abs(e.clientY - dragStartY);
      dragSelectionBox.style.left = left + "px";
      dragSelectionBox.style.top = top + "px";
      dragSelectionBox.style.width = width + "px";
      dragSelectionBox.style.height = height + "px";
    } else if (!isDragging && !pinnedElement && overlay && overlayLabel) {
      // Use composedPath() for shadow DOM support; fall back to elementFromPoint
      var composed = e.composedPath ? e.composedPath() : [];
      var element = null;
      for (var pi = 0; pi < composed.length; pi++) {
        var node = composed[pi];
        if (node.nodeType === 1 && !isInspectElement(node)) {
          element = node;
          break;
        }
      }
      if (!element) element = document.elementFromPoint(e.clientX, e.clientY);
      if (element && !isInspectElement(element)) {
        var rect = element.getBoundingClientRect();
        overlay.style.display = "";
        overlay.style.left = rect.left + "px";
        overlay.style.top = rect.top + "px";
        overlay.style.width = rect.width + "px";
        overlay.style.height = rect.height + "px";

        // Build label: React component name > tag + identifier + dimensions
        var tagName = element.tagName.toLowerCase();
        var dims = Math.round(rect.width) + "\u00d7" + Math.round(rect.height);
        var reactInfo = getReactComponentInfo(element);
        var label = "";

        if (reactInfo.componentName) {
          label = "\u269b " + reactInfo.componentName + " \u2022 " + dims;
        } else {
          var htmlEl = element;
          var id = htmlEl.id;
          var testId = htmlEl.getAttribute("data-testid") || htmlEl.getAttribute("data-test-id");
          var role = htmlEl.getAttribute("role");
          var ariaLabel = htmlEl.getAttribute("aria-label");
          var ident = "";

          if (id) {
            ident = "#" + id;
          } else if (testId) {
            ident = '[data-testid="' + testId + '"]';
          } else if (role) {
            ident = '[role="' + role + '"]';
          } else if (ariaLabel) {
            ident =
              '[aria-label="' +
              ariaLabel.substring(0, 20) +
              (ariaLabel.length > 20 ? "..." : "") +
              '"]';
          } else {
            var classes = htmlEl.className
              ? String(htmlEl.className).split(" ").filter(Boolean)
              : [];
            var meaningful = null;
            for (var ci = 0; ci < classes.length; ci++) {
              if (!TAILWIND_PATTERN.test(classes[ci])) {
                meaningful = classes[ci];
                break;
              }
            }
            if (meaningful) ident = "." + meaningful;
          }

          label = ident ? tagName + ident + " \u2022 " + dims : tagName + " \u2022 " + dims;
        }

        overlayLabel.style.display = "";
        overlayLabel.textContent = label;
        var labelTop = rect.top > 20 ? rect.top - 20 : rect.top + 2;
        overlayLabel.style.left = rect.left + "px";
        overlayLabel.style.top = labelTop + "px";
      }
    }
  }

  // Shared element capture logic — used by handleMouseUp for click-like
  // interactions (drag <= 5px). We do element selection in mouseup instead
  // of click because WKWebView may not synthesize a click event when the
  // mousedown and mouseup targets differ (common with tiny trackpad movements).
  function captureElement(clientX, clientY) {
    // Use elementFromPoint — reliable since we have exact coordinates
    var element = document.elementFromPoint(clientX, clientY);
    if (!element || isInspectElement(element)) return null;
    // Walk up past text nodes or non-element nodes
    while (element && element.nodeType !== 1) element = element.parentElement;
    if (!element || !element.tagName) return null;

    var rect = element.getBoundingClientRect();
    var cs = window.getComputedStyle(element);

    // Build selector path with sibling index disambiguation.
    // Path like "div.container > div.card[2] > button.primary" lets the AI
    // agent locate elements unambiguously even when siblings share the same tag.
    var pathParts = [];
    var cur = element;
    while (cur && cur !== document.body) {
      var seg = cur.tagName.toLowerCase();
      if (cur.id) {
        seg += "#" + cur.id;
      } else {
        // Add first meaningful class (skip Tailwind utility classes)
        if (cur.className && typeof cur.className === "string") {
          var classes = cur.className.trim().split(/\s+/);
          for (var ci = 0; ci < classes.length; ci++) {
            if (!TAILWIND_PATTERN.test(classes[ci])) {
              seg += "." + classes[ci];
              break;
            }
          }
        }
        // Disambiguate when parent has multiple children with the same tag
        if (cur.parentElement) {
          var siblings = cur.parentElement.children;
          var sameTagCount = 0;
          var selfIndex = 0;
          for (var sib = 0; sib < siblings.length; sib++) {
            if (siblings[sib].tagName === cur.tagName) {
              sameTagCount++;
              if (siblings[sib] === cur) selfIndex = sameTagCount;
            }
          }
          if (sameTagCount > 1) seg += "[" + selfIndex + "]";
        }
      }
      pathParts.unshift(seg);
      cur = cur.parentElement;
    }

    var reactInfo = getReactComponentInfo(element);

    // Counter-based stable element ID (replaces random refs)
    var ref = getOrAssignElementId(element);
    var selectionKey = createSelectionKey(ref);

    // Only keep non-Tailwind semantic classes (Tailwind utilities are noise for the AI)
    var className = "";
    if (typeof element.className === "string") {
      var elClasses = element.className.trim().split(/\s+/);
      var semantic = [];
      for (var sci = 0; sci < elClasses.length; sci++) {
        if (elClasses[sci] && !TAILWIND_PATTERN.test(elClasses[sci])) {
          semantic.push(elClasses[sci]);
        }
      }
      className = semantic.join(" ");
      if (className.length > 200) className = className.substring(0, 200);
    }

    // Prefer innerText, fall back to accessible name, then textContent
    var text = element.innerText || "";
    if (!text) {
      var accName = computeAccessibleName(element);
      if (accName) text = accName;
      else text = element.textContent || "";
    }
    if (text.length > 200) text = text.substring(0, 200);

    // Detect context: local dev server vs external website
    var host = window.location.hostname;
    var context =
      host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" ? "local" : "external";

    // Context-aware CSS: the AI needs different data for local dev vs external sites.
    // Local: only var() design tokens + font-size/border-radius (read source for the rest).
    // External: 10 key visual properties for design reference.
    var styles = {};
    var varDecls = getMatchedVarDeclarations(element);

    if (context === "local") {
      // LOCAL: Only properties with var() token references + font-size + border-radius.
      // The AI should read the source file for full styling context.
      var localProps = [
        "background-color",
        "color",
        "border-color",
        "font-size",
        "font-weight",
        "border-radius",
        "padding",
        "gap",
      ];
      for (var sp = 0; sp < localProps.length; sp++) {
        var prop = localProps[sp];
        var varVal = varDecls[prop];
        if (varVal) {
          // Has a var() token — always include (most actionable for local dev)
          styles[prop] = varVal;
        } else {
          // Include font-size, border-radius, and font-weight even without var() tokens
          var compVal = cs.getPropertyValue(prop);
          if (
            (prop === "font-size" || prop === "border-radius" || prop === "font-weight") &&
            compVal &&
            compVal !== "0px" &&
            compVal !== "none" &&
            compVal !== "normal"
          ) {
            styles[prop] = compVal;
          }
        }
      }
    } else {
      // EXTERNAL: 10 key visual properties for design reference
      var externalProps = [
        "background-color",
        "color",
        "font-size",
        "font-weight",
        "font-family",
        "border-radius",
        "padding",
        "gap",
        "box-shadow",
        "opacity",
      ];
      for (var ep = 0; ep < externalProps.length; ep++) {
        var eprop = externalProps[ep];
        var eval_ = varDecls[eprop] || cs.getPropertyValue(eprop);
        if (
          eval_ &&
          eval_ !== "none" &&
          eval_ !== "normal" &&
          eval_ !== "0px" &&
          eval_ !== "rgba(0, 0, 0, 0)" &&
          eval_ !== "transparent" &&
          eval_ !== "auto"
        ) {
          var finalVal = eval_;
          if ((eprop === "background-color" || eprop === "color") && eval_.indexOf("var(") === -1) {
            var hex = convertColorToHex(eval_);
            if (hex) finalVal = hex;
          }
          styles[eprop] = finalVal;
        }
      }
    }

    // Cap path length on deeply nested elements
    var pathStr = pathParts.join(" > ");
    if (pathStr.length > 500) pathStr = pathStr.substring(pathStr.length - 500);

    // Extract new data fields for AI context.
    // Gate React props and innerHTML to local context only — external sites
    // may expose sensitive data (user tokens in props, CSRF tokens in innerHTML).
    var reactProps = context === "local" ? getReactProps(element) : null;
    var htmlAttrs = getFilteredAttributes(element);
    var innerHTML = context === "local" ? getShallowInnerHTML(element) : null;

    sendToFrontend("element-event", {
      type: "element-selected",
      ref: ref,
      selectionKey: selectionKey,
      context: context,
      element: {
        tagName: element.tagName,
        id: element.id || undefined,
        className: className || undefined,
        innerText: text || undefined,
        path: pathStr,
        rect: {
          top: Math.round(rect.top),
          left: Math.round(rect.left),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        styles: styles,
        props: reactProps || undefined,
        attributes: htmlAttrs || undefined,
        innerHTML: innerHTML || undefined,
      },
      reactComponent: reactInfo.componentName
        ? {
            name: reactInfo.componentName,
            fileName: reactInfo.fileName,
            lineNumber: reactInfo.lineNumber,
          }
        : undefined,
      url: window.location.href,
      timestamp: Date.now(),
    });
    return { element: element, selectionKey: selectionKey };
  }

  function handleMouseUp(e) {
    if (!selectionMode) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    if (isDragging) {
      var width = Math.abs(e.clientX - dragStartX);
      var height = Math.abs(e.clientY - dragStartY);

      if (width > 5 || height > 5) {
        // Drag selection — send area bounds
        var left = Math.min(dragStartX, e.clientX);
        var top = Math.min(dragStartY, e.clientY);
        sendToFrontend("element-event", {
          type: "area-selected",
          bounds: {
            x: Math.round(left),
            y: Math.round(top),
            width: Math.round(width),
            height: Math.round(height),
          },
          url: window.location.href,
          timestamp: Date.now(),
        });
      } else {
        // Click-like interaction (<=5px movement) — capture the element.
        // Done here in mouseup instead of handleClick because WKWebView
        // may not synthesize a click event when mousedown and mouseup
        // targets differ (common with tiny trackpad movements).
        var captured = captureElement(dragStartX, dragStartY);
        if (captured) {
          // Pin the blue border to the selected element so the user keeps
          // a visible "this is what you're editing" anchor while the host
          // prompt is open. Hover redraws are suppressed while pinned.
          pinnedElement = captured.element;
          pinnedSelectionKey = captured.selectionKey;
          if (overlay) {
            var pr = captured.element.getBoundingClientRect();
            overlay.style.display = "";
            overlay.style.left = pr.left + "px";
            overlay.style.top = pr.top + "px";
            overlay.style.width = pr.width + "px";
            overlay.style.height = pr.height + "px";
          }
          // The host overlay shows the element identity — keep the guest
          // dimension label hidden in pinned state.
          if (overlayLabel) overlayLabel.style.display = "none";
        }
      }

      if (dragSelectionBox) {
        dragSelectionBox.remove();
        dragSelectionBox = null;
      }
      isDragging = false;
      // Restore cursor visibility after capture/drag completes
      if (selectionCursor) selectionCursor.style.display = "";
    }
  }

  // handleClick only blocks the event from reaching the page.
  // Element selection is done in handleMouseUp (more reliable in WKWebView).
  function handleClick(e) {
    if (!selectionMode) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function handleKeyDown(e) {
    if (!selectionMode) return;
    // Block ALL keyboard events from reaching the page while inspecting
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (e.key === "Escape") {
      disableSelectionMode();
    }
  }

  // ========================================================================
  // Public API on window
  // ========================================================================
  window.__deusInspect = {
    enable: enableSelectionMode,
    disable: disableSelectionMode,
    isActive: function() { return selectionMode; },
    /** Drain all buffered events and return them as a JSON string.
     *  Called by the React side via eval_browser_webview_with_result. */
    drainEvents: function() {
      var events = eventBuffer.splice(0, eventBuffer.length);
      return JSON.stringify(events);
    },
    /** Hide or show the hover overlay + label + custom cursor. The host
     *  toggles these OFF briefly before capturing a region screenshot so
     *  the inspector's paint doesn't appear on top of the element, then
     *  toggles them back ON. No-op if the elements don't exist (inspect
     *  mode isn't active). Respects pinned state: when restoring, the
     *  dimension label stays hidden so pinning reads clean. */
    setOverlaysVisible: function(visible) {
      if (!visible) {
        if (overlay) overlay.style.display = "none";
        if (overlayLabel) overlayLabel.style.display = "none";
        if (selectionCursor) selectionCursor.style.display = "none";
        return;
      }
      if (overlay) overlay.style.display = "";
      if (selectionCursor) selectionCursor.style.display = "";
      // Only un-hide the dimension label when there's no pinned selection;
      // the host overlay already shows the element identity in pinned mode.
      if (overlayLabel && !pinnedElement) overlayLabel.style.display = "";
    },
    /** Release the pinned selection so the blue border returns to
     *  hover-tracking. When `expectedSelectionKey` is provided, only clear
     *  if that same click selection is still pinned. This prevents an older
     *  async host cleanup from erasing a newer click on the same element. */
    clearSelection: function(expectedSelectionKey) {
      if (pinnedElement && expectedSelectionKey !== undefined) {
        if (pinnedSelectionKey !== expectedSelectionKey) return false;
      }
      pinnedElement = null;
      pinnedSelectionKey = null;
      if (overlay) overlay.style.display = "none";
      if (overlayLabel) overlayLabel.style.display = "none";
      return true;
    },
  };

  console.log("[deus-inspect] SETUP complete — window.__deusInspect installed");
})();
