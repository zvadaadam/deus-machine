// src/features/browser/automation/inspect-mode.ts
// JavaScript injection for inspect/design mode inside WKWebView.
//
// When eval'd, creates interactive element selection:
// - Hover overlay with bounding box and element label
// - Click to capture element data (selector, rect, styles, React component)
// - Drag-to-select for area screenshots
// - Custom SVG cursor replacing system cursor
// - Escape to exit
//
// Communication back to frontend via title-channel:
//   \x01CE:{json} — element selected event
//   \x01CS:{json} — selection mode state change
//
// Ported from mcp-dev-browser's element-selector.ts, adapted for
// native WKWebView (no iframe postMessage available).

/**
 * JS code to inject inspect mode into the webview.
 * Call via eval_browser_webview to set up. Then call
 * INSPECT_MODE_ENABLE / INSPECT_MODE_DISABLE to toggle.
 */
export const INSPECT_MODE_SETUP = `(function(){
  if (window.__conductorInspectMode) return;
  window.__conductorInspectMode = true;

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

  // ========================================================================
  // Title-Channel Communication
  // ========================================================================
  // Uses setTimeout to restore title in next event loop tick — prevents
  // WKWebView from coalescing the title changes across the process boundary.
  function sendToFrontend(prefix, data) {
    try {
      var orig = document.title;
      document.title = prefix + JSON.stringify(data);
      setTimeout(function() { document.title = orig; }, 0);
    } catch(e) {}
  }

  // ========================================================================
  // React Fiber Detection
  // ========================================================================
  function getReactComponentInfo(el) {
    try {
      var keys = Object.keys(el);
      var fiberKey = null;
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].indexOf('__reactFiber') === 0 || keys[i].indexOf('__reactInternalInstance') === 0) {
          fiberKey = keys[i];
          break;
        }
      }
      if (!fiberKey) return { componentName: null, fileName: null, lineNumber: null };

      var fiber = el[fiberKey];
      while (fiber) {
        var type = fiber.type;
        if (type && typeof type === 'function') {
          var name = type.displayName || type.name || 'Anonymous';
          var fileName = null;
          var lineNumber = null;
          if (fiber._debugSource) {
            fileName = fiber._debugSource.fileName;
            lineNumber = fiber._debugSource.lineNumber;
          }
          return { componentName: name, fileName: fileName, lineNumber: lineNumber };
        }
        fiber = fiber.return;
      }
    } catch(e) {}
    return { componentName: null, fileName: null, lineNumber: null };
  }

  // ========================================================================
  // Custom SVG Cursor
  // ========================================================================
  function createSelectionCursor() {
    var svgNS = 'http://www.w3.org/2000/svg';
    var cursor = document.createElementNS(svgNS, 'svg');
    cursor.setAttribute('width', '16');
    cursor.setAttribute('height', '16');
    cursor.setAttribute('viewBox', '0 0 16 16');
    cursor.setAttribute('fill', 'none');
    cursor.setAttribute('data-conductor-inspect', 'true');
    cursor.setAttribute('aria-hidden', 'true');
    cursor.style.position = 'fixed';
    cursor.style.pointerEvents = 'none';
    cursor.style.zIndex = '2147483646';
    cursor.style.transform = 'translate(-50%, -50%)';
    cursor.style.left = '-1000px';
    cursor.style.top = '-1000px';
    cursor.style.transition = 'opacity 150ms ease';

    var gClip = document.createElementNS(svgNS, 'g');
    gClip.setAttribute('clip-path', 'url(#clip0_conductor)');
    var gFilter = document.createElementNS(svgNS, 'g');
    gFilter.setAttribute('filter', 'url(#filter0_conductor)');

    var path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', 'M1.68066 2.14282C1.5253 1.49746 2.16954 0.975576 2.75195 1.21118L2.86816 1.26782L3.11035 1.41333L12.958 7.27954L13.2031 7.42505C13.8128 7.78856 13.682 8.70779 12.9951 8.88696L12.7197 8.95825L8.28223 10.1155L6.16895 13.9592L6.02148 14.2288C5.66933 14.869 4.71301 14.741 4.54199 14.0305L4.4707 13.7317L1.74707 2.41724L1.68066 2.14282Z');
    path.setAttribute('fill', 'black');
    path.setAttribute('stroke', 'white');
    gFilter.appendChild(path);
    gClip.appendChild(gFilter);

    var defs = document.createElementNS(svgNS, 'defs');
    var filter = document.createElementNS(svgNS, 'filter');
    filter.setAttribute('id', 'filter0_conductor');
    filter.setAttribute('x', '-1.51');
    filter.setAttribute('y', '-1.35');
    filter.setAttribute('width', '18.27');
    filter.setAttribute('height', '19.83');
    filter.setAttribute('filterUnits', 'userSpaceOnUse');
    filter.setAttribute('color-interpolation-filters', 'sRGB');

    var feFlood = document.createElementNS(svgNS, 'feFlood');
    feFlood.setAttribute('flood-opacity', '0');
    feFlood.setAttribute('result', 'BackgroundImageFix');
    filter.appendChild(feFlood);
    var feCM = document.createElementNS(svgNS, 'feColorMatrix');
    feCM.setAttribute('in', 'SourceAlpha');
    feCM.setAttribute('type', 'matrix');
    feCM.setAttribute('values', '0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0');
    feCM.setAttribute('result', 'hardAlpha');
    filter.appendChild(feCM);
    var feOff = document.createElementNS(svgNS, 'feOffset');
    feOff.setAttribute('dy', '0.667');
    filter.appendChild(feOff);
    var feBlur = document.createElementNS(svgNS, 'feGaussianBlur');
    feBlur.setAttribute('stdDeviation', '1.333');
    filter.appendChild(feBlur);
    var feComp = document.createElementNS(svgNS, 'feComposite');
    feComp.setAttribute('in2', 'hardAlpha');
    feComp.setAttribute('operator', 'out');
    filter.appendChild(feComp);
    var feCM2 = document.createElementNS(svgNS, 'feColorMatrix');
    feCM2.setAttribute('type', 'matrix');
    feCM2.setAttribute('values', '0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.5 0');
    filter.appendChild(feCM2);
    var feB1 = document.createElementNS(svgNS, 'feBlend');
    feB1.setAttribute('mode', 'normal');
    feB1.setAttribute('in2', 'BackgroundImageFix');
    feB1.setAttribute('result', 'effect1');
    filter.appendChild(feB1);
    var feB2 = document.createElementNS(svgNS, 'feBlend');
    feB2.setAttribute('mode', 'normal');
    feB2.setAttribute('in', 'SourceGraphic');
    feB2.setAttribute('in2', 'effect1');
    feB2.setAttribute('result', 'shape');
    filter.appendChild(feB2);
    defs.appendChild(filter);

    var clipPath = document.createElementNS(svgNS, 'clipPath');
    clipPath.setAttribute('id', 'clip0_conductor');
    var rect = document.createElementNS(svgNS, 'rect');
    rect.setAttribute('width', '16');
    rect.setAttribute('height', '16');
    rect.setAttribute('fill', 'white');
    clipPath.appendChild(rect);
    defs.appendChild(clipPath);

    cursor.appendChild(defs);
    cursor.appendChild(gClip);
    return cursor;
  }

  // ========================================================================
  // Enable / Disable Selection Mode
  // ========================================================================
  function enableSelectionMode() {
    if (selectionMode) return;
    selectionMode = true;
    document.body.style.cursor = 'none';

    if (!cursorStyleOverride) {
      cursorStyleOverride = document.createElement('style');
      cursorStyleOverride.textContent = '* { cursor: none !important; }';
      document.head.appendChild(cursorStyleOverride);
    }

    if (!selectionCursor) {
      selectionCursor = createSelectionCursor();
      document.body.appendChild(selectionCursor);
    }

    if (!overlay) {
      overlay = document.createElement('div');
      overlay.setAttribute('data-conductor-inspect', 'true');
      overlay.style.cssText = 'position:fixed;background:rgba(58,150,221,0.3);border:2px solid #3a96dd;pointer-events:none;z-index:2147483647;transition:all 0.1s ease;display:none;';
      document.body.appendChild(overlay);

      overlayLabel = document.createElement('div');
      overlayLabel.setAttribute('data-conductor-inspect', 'true');
      overlayLabel.style.cssText = 'position:fixed;background:#3a96dd;color:white;padding:2px 6px;font-size:11px;font-family:system-ui,-apple-system,sans-serif;font-weight:500;border-radius:2px;pointer-events:none;z-index:2147483648;transition:all 0.1s ease;white-space:nowrap;display:none;';
      document.body.appendChild(overlayLabel);
    }

    document.addEventListener('mousedown', handleMouseDown, true);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp, true);
    document.addEventListener('click', handleClick, true);
    document.addEventListener('keydown', handleKeyDown, true);

    sendToFrontend('\\x01CS:',{ active: true });
  }

  function disableSelectionMode() {
    if (!selectionMode) return;
    selectionMode = false;
    document.body.style.cursor = '';

    if (cursorStyleOverride) { cursorStyleOverride.remove(); cursorStyleOverride = null; }
    if (selectionCursor) { selectionCursor.remove(); selectionCursor = null; }
    if (overlay) { overlay.remove(); overlay = null; }
    if (overlayLabel) { overlayLabel.remove(); overlayLabel = null; }
    if (dragSelectionBox) { dragSelectionBox.remove(); dragSelectionBox = null; }

    document.removeEventListener('mousedown', handleMouseDown, true);
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp, true);
    document.removeEventListener('click', handleClick, true);
    document.removeEventListener('keydown', handleKeyDown, true);

    sendToFrontend('\\x01CS:',{ active: false });
  }

  // ========================================================================
  // Event Handlers
  // ========================================================================
  function isInspectElement(el) {
    return el && el.getAttribute && el.getAttribute('data-conductor-inspect') === 'true';
  }

  function handleMouseDown(e) {
    if (!selectionMode) return;
    e.preventDefault();
    e.stopPropagation();

    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;

    if (overlay) overlay.style.display = 'none';
    if (overlayLabel) overlayLabel.style.display = 'none';

    if (!dragSelectionBox) {
      dragSelectionBox = document.createElement('div');
      dragSelectionBox.setAttribute('data-conductor-inspect', 'true');
      dragSelectionBox.style.cssText = 'position:fixed;background:rgba(58,150,221,0.1);border:2px dashed #3a96dd;pointer-events:none;z-index:2147483647;';
      document.body.appendChild(dragSelectionBox);
    }
    dragSelectionBox.style.left = dragStartX + 'px';
    dragSelectionBox.style.top = dragStartY + 'px';
    dragSelectionBox.style.width = '0px';
    dragSelectionBox.style.height = '0px';
  }

  function handleMouseMove(e) {
    if (!selectionMode) return;

    if (selectionCursor) {
      selectionCursor.style.left = e.clientX + 'px';
      selectionCursor.style.top = e.clientY + 'px';
    }

    if (isDragging && dragSelectionBox) {
      var left = Math.min(dragStartX, e.clientX);
      var top = Math.min(dragStartY, e.clientY);
      var width = Math.abs(e.clientX - dragStartX);
      var height = Math.abs(e.clientY - dragStartY);
      dragSelectionBox.style.left = left + 'px';
      dragSelectionBox.style.top = top + 'px';
      dragSelectionBox.style.width = width + 'px';
      dragSelectionBox.style.height = height + 'px';
    } else if (!isDragging && overlay && overlayLabel) {
      var element = document.elementFromPoint(e.clientX, e.clientY);
      if (element && !isInspectElement(element)) {
        var rect = element.getBoundingClientRect();
        overlay.style.display = '';
        overlay.style.left = rect.left + 'px';
        overlay.style.top = rect.top + 'px';
        overlay.style.width = rect.width + 'px';
        overlay.style.height = rect.height + 'px';

        // Build label: React component name > tag + identifier + dimensions
        var tagName = element.tagName.toLowerCase();
        var dims = Math.round(rect.width) + '\\u00d7' + Math.round(rect.height);
        var reactInfo = getReactComponentInfo(element);
        var label = '';

        if (reactInfo.componentName) {
          label = '\\u269b ' + reactInfo.componentName + ' \\u2022 ' + dims;
        } else {
          var htmlEl = element;
          var id = htmlEl.id;
          var testId = htmlEl.getAttribute('data-testid') || htmlEl.getAttribute('data-test-id');
          var role = htmlEl.getAttribute('role');
          var ariaLabel = htmlEl.getAttribute('aria-label');
          var ident = '';

          if (id) { ident = '#' + id; }
          else if (testId) { ident = '[data-testid="' + testId + '"]'; }
          else if (role) { ident = '[role="' + role + '"]'; }
          else if (ariaLabel) { ident = '[aria-label="' + ariaLabel.substring(0,20) + (ariaLabel.length > 20 ? '...' : '') + '"]'; }
          else {
            var classes = htmlEl.className ? String(htmlEl.className).split(' ').filter(Boolean) : [];
            var meaningful = null;
            for (var ci = 0; ci < classes.length; ci++) {
              if (!/^(flex|grid|p-|m-|text-|bg-|border|rounded|w-|h-|gap-|items-|justify-|overflow-|opacity-|transition|duration|ease|hover:|focus:|active:|dark:)/.test(classes[ci])) {
                meaningful = classes[ci]; break;
              }
            }
            if (meaningful) ident = '.' + meaningful;
          }

          label = ident ? tagName + ident + ' \\u2022 ' + dims : tagName + ' \\u2022 ' + dims;
        }

        overlayLabel.style.display = '';
        overlayLabel.textContent = label;
        var labelTop = rect.top > 20 ? rect.top - 20 : rect.top + 2;
        overlayLabel.style.left = rect.left + 'px';
        overlayLabel.style.top = labelTop + 'px';
      }
    }
  }

  function handleMouseUp(e) {
    if (!selectionMode) return;
    e.preventDefault();
    e.stopPropagation();

    if (isDragging) {
      var left = Math.min(dragStartX, e.clientX);
      var top = Math.min(dragStartY, e.clientY);
      var width = Math.abs(e.clientX - dragStartX);
      var height = Math.abs(e.clientY - dragStartY);

      if (width > 5 || height > 5) {
        sendToFrontend('\\x01CE:',{
          type: 'area-selected',
          bounds: { x: Math.round(left), y: Math.round(top), width: Math.round(width), height: Math.round(height) },
          url: window.location.href,
          timestamp: Date.now()
        });
      }

      if (dragSelectionBox) { dragSelectionBox.remove(); dragSelectionBox = null; }
      isDragging = false;
    }
  }

  function handleClick(e) {
    if (!selectionMode || isDragging) return;
    e.preventDefault();
    e.stopPropagation();

    var element = e.target;
    if (isInspectElement(element)) return;

    var rect = element.getBoundingClientRect();
    var cs = window.getComputedStyle(element);

    // Build selector path
    var path = [];
    var el = element;
    while (el && el !== document.body) {
      var sel = el.tagName.toLowerCase();
      if (el.id) sel += '#' + el.id;
      else if (el.className && typeof el.className === 'string') {
        var cls = el.className.trim().split(/\\s+/).slice(0,2).join('.');
        if (cls) sel += '.' + cls;
      }
      path.unshift(sel);
      el = el.parentElement;
    }

    var reactInfo = getReactComponentInfo(element);

    // Get or assign data-cursor-ref for AI targeting
    var ref = element.getAttribute('data-cursor-ref');
    if (!ref) {
      ref = 'ref-' + Math.random().toString(36).substring(2, 15);
      element.setAttribute('data-cursor-ref', ref);
    }

    sendToFrontend('\\x01CE:',{
      type: 'element-selected',
      ref: ref,
      element: {
        tagName: element.tagName,
        id: element.id || undefined,
        className: (typeof element.className === 'string' ? element.className : '') || undefined,
        innerText: element.innerText ? element.innerText.substring(0, 200) : undefined,
        path: path.join(' > '),
        rect: { top: Math.round(rect.top), left: Math.round(rect.left), width: Math.round(rect.width), height: Math.round(rect.height) },
        computedStyle: {
          color: cs.color,
          backgroundColor: cs.backgroundColor,
          fontSize: cs.fontSize,
          fontFamily: cs.fontFamily,
          display: cs.display,
          position: cs.position
        }
      },
      reactComponent: reactInfo.componentName ? {
        name: reactInfo.componentName,
        fileName: reactInfo.fileName,
        lineNumber: reactInfo.lineNumber
      } : undefined,
      url: window.location.href,
      timestamp: Date.now()
    });
  }

  function handleKeyDown(e) {
    if (!selectionMode) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      disableSelectionMode();
    }
  }

  // ========================================================================
  // Public API on window
  // ========================================================================
  window.__conductorInspect = {
    enable: enableSelectionMode,
    disable: disableSelectionMode,
    isActive: function() { return selectionMode; }
  };
})()`;

/** Enable inspect mode (call after INSPECT_MODE_SETUP has been eval'd) */
export const INSPECT_MODE_ENABLE = `(function(){
  if (window.__conductorInspect) window.__conductorInspect.enable();
})()`;

/** Disable inspect mode */
export const INSPECT_MODE_DISABLE = `(function(){
  if (window.__conductorInspect) window.__conductorInspect.disable();
})()`;

/** Check if inspect mode is active */
export const INSPECT_MODE_IS_ACTIVE = `(function(){
  return JSON.stringify({ active: window.__conductorInspect ? window.__conductorInspect.isActive() : false });
})()`;
