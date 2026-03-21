"use strict";
(() => {
  // apps/web/src/features/browser/automation/inject/inspect-mode.ts
  if (!window.__opendevsInspectMode) {
    let sendToFrontend = function(type, data) {
      eventBuffer.push({ type, data });
    }, getOrAssignElementId = function(el) {
      const existing = el.getAttribute("data-opendevs-ref");
      if (existing) return existing;
      elementIdCounter++;
      const id = "opendevs-" + elementIdCounter;
      el.setAttribute("data-opendevs-ref", id);
      return id;
    }, getReactComponentInfo = function(el) {
      try {
        const keys = Object.keys(el);
        let fiberKey = null;
        for (let i = 0; i < keys.length; i++) {
          if (keys[i].indexOf("__reactFiber") === 0 || keys[i].indexOf("__reactInternalInstance") === 0) {
            fiberKey = keys[i];
            break;
          }
        }
        if (!fiberKey) return { componentName: null, fileName: null, lineNumber: null };
        let fiber = el[fiberKey];
        while (fiber) {
          const type = fiber.elementType || fiber.type;
          let compName = null;
          if (type && typeof type === "function") {
            compName = type.displayName || type.name || "Anonymous";
          } else if (type && typeof type === "object") {
            const symStr = type.$$typeof ? type.$$typeof.toString() : "";
            if (symStr.indexOf("forward_ref") !== -1 && type.render) {
              compName = type.render.displayName || type.render.name || type.displayName || "ForwardRef";
            } else if (symStr.indexOf("memo") !== -1 && type.type) {
              const inner = type.type;
              if (typeof inner === "function") {
                compName = inner.displayName || inner.name || "Memo";
              }
            }
          }
          if (compName) {
            let fileName = null;
            let lineNumber = null;
            if (fiber._debugSource) {
              fileName = fiber._debugSource.fileName;
              lineNumber = fiber._debugSource.lineNumber;
            }
            return { componentName: compName, fileName, lineNumber };
          }
          fiber = fiber.return;
        }
      } catch (_e) {
      }
      return { componentName: null, fileName: null, lineNumber: null };
    }, computeAccessibleName = function(el) {
      try {
        const labelledBy = el.getAttribute("aria-labelledby");
        if (labelledBy) {
          const ids = labelledBy.split(/\s+/);
          const texts = [];
          for (let i = 0; i < ids.length; i++) {
            const refEl = document.getElementById(ids[i]);
            if (refEl) texts.push(refEl.textContent || "");
          }
          const joined = texts.join(" ").trim();
          if (joined) return joined;
        }
        const ariaLabel = el.getAttribute("aria-label");
        if (ariaLabel) return ariaLabel;
        if (el.id) {
          const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
          if (label) return (label.textContent || "").trim();
        }
        const ph = el.getAttribute("placeholder");
        if (ph) return ph;
        const alt = el.getAttribute("alt");
        if (alt) return alt;
        const title = el.getAttribute("title");
        if (title) return title;
      } catch (_e) {
      }
      return null;
    }, convertColorToHex = function(color) {
      if (!color || color === "transparent" || color === "rgba(0, 0, 0, 0)") return null;
      if (color.charAt(0) === "#") return color;
      const rgbaMatch = color.match(/^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/);
      if (rgbaMatch) {
        const r = parseInt(rgbaMatch[1], 10);
        const g = parseInt(rgbaMatch[2], 10);
        const b = parseInt(rgbaMatch[3], 10);
        return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
      }
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
        const data = colorCtx.getImageData(0, 0, 1, 1).data;
        return "#" + ((1 << 24) + (data[0] << 16) + (data[1] << 8) + data[2]).toString(16).slice(1);
      } catch (_e) {
        return color;
      }
    }, getMatchedVarDeclarations = function(el) {
      const cached = varDeclCache.get(el);
      if (cached && Date.now() - cached.ts < VAR_CACHE_TTL) return cached.decls;
      const decls = {};
      const varScanProps = ["background-color", "color", "border-color", "padding", "gap"];
      try {
        const sheets = document.styleSheets;
        for (let si = 0; si < sheets.length; si++) {
          let rules;
          try {
            rules = sheets[si].cssRules;
          } catch (_e) {
            continue;
          }
          if (!rules) continue;
          for (let ri = 0; ri < rules.length; ri++) {
            const rule = rules[ri];
            if (!rule.selectorText || !rule.style) continue;
            try {
              if (!el.matches(rule.selectorText)) continue;
            } catch (_e) {
              continue;
            }
            for (let ci = 0; ci < varScanProps.length; ci++) {
              const val = rule.style.getPropertyValue(varScanProps[ci]);
              if (val && val.indexOf("var(") !== -1) {
                decls[varScanProps[ci]] = val.trim();
              }
            }
          }
        }
      } catch (_e) {
      }
      varDeclCache.set(el, { ts: Date.now(), decls });
      return decls;
    }, createSelectionCursor = function() {
      const svgNS = "http://www.w3.org/2000/svg";
      const cursor = document.createElementNS(svgNS, "svg");
      cursor.setAttribute("width", "16");
      cursor.setAttribute("height", "16");
      cursor.setAttribute("viewBox", "0 0 16 16");
      cursor.setAttribute("fill", "none");
      cursor.setAttribute("data-opendevs-inspect", "true");
      cursor.setAttribute("aria-hidden", "true");
      cursor.style.position = "fixed";
      cursor.style.pointerEvents = "none";
      cursor.style.zIndex = "2147483646";
      cursor.style.transform = "translate(-50%, -50%)";
      cursor.style.left = "-1000px";
      cursor.style.top = "-1000px";
      cursor.style.transition = "opacity 150ms ease";
      const gClip = document.createElementNS(svgNS, "g");
      gClip.setAttribute("clip-path", "url(#clip0_hive)");
      const gFilter = document.createElementNS(svgNS, "g");
      gFilter.setAttribute("filter", "url(#filter0_hive)");
      const path = document.createElementNS(svgNS, "path");
      path.setAttribute(
        "d",
        "M1.68066 2.14282C1.5253 1.49746 2.16954 0.975576 2.75195 1.21118L2.86816 1.26782L3.11035 1.41333L12.958 7.27954L13.2031 7.42505C13.8128 7.78856 13.682 8.70779 12.9951 8.88696L12.7197 8.95825L8.28223 10.1155L6.16895 13.9592L6.02148 14.2288C5.66933 14.869 4.71301 14.741 4.54199 14.0305L4.4707 13.7317L1.74707 2.41724L1.68066 2.14282Z"
      );
      path.setAttribute("fill", "black");
      path.setAttribute("stroke", "white");
      gFilter.appendChild(path);
      gClip.appendChild(gFilter);
      const defs = document.createElementNS(svgNS, "defs");
      const filter = document.createElementNS(svgNS, "filter");
      filter.setAttribute("id", "filter0_hive");
      filter.setAttribute("x", "-1.51");
      filter.setAttribute("y", "-1.35");
      filter.setAttribute("width", "18.27");
      filter.setAttribute("height", "19.83");
      filter.setAttribute("filterUnits", "userSpaceOnUse");
      filter.setAttribute("color-interpolation-filters", "sRGB");
      const feFlood = document.createElementNS(svgNS, "feFlood");
      feFlood.setAttribute("flood-opacity", "0");
      feFlood.setAttribute("result", "BackgroundImageFix");
      filter.appendChild(feFlood);
      const feCM = document.createElementNS(svgNS, "feColorMatrix");
      feCM.setAttribute("in", "SourceAlpha");
      feCM.setAttribute("type", "matrix");
      feCM.setAttribute("values", "0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0");
      feCM.setAttribute("result", "hardAlpha");
      filter.appendChild(feCM);
      const feOff = document.createElementNS(svgNS, "feOffset");
      feOff.setAttribute("dy", "0.667");
      filter.appendChild(feOff);
      const feBlur = document.createElementNS(svgNS, "feGaussianBlur");
      feBlur.setAttribute("stdDeviation", "1.333");
      filter.appendChild(feBlur);
      const feComp = document.createElementNS(svgNS, "feComposite");
      feComp.setAttribute("in2", "hardAlpha");
      feComp.setAttribute("operator", "out");
      filter.appendChild(feComp);
      const feCM2 = document.createElementNS(svgNS, "feColorMatrix");
      feCM2.setAttribute("type", "matrix");
      feCM2.setAttribute("values", "0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.5 0");
      filter.appendChild(feCM2);
      const feB1 = document.createElementNS(svgNS, "feBlend");
      feB1.setAttribute("mode", "normal");
      feB1.setAttribute("in2", "BackgroundImageFix");
      feB1.setAttribute("result", "effect1");
      filter.appendChild(feB1);
      const feB2 = document.createElementNS(svgNS, "feBlend");
      feB2.setAttribute("mode", "normal");
      feB2.setAttribute("in", "SourceGraphic");
      feB2.setAttribute("in2", "effect1");
      feB2.setAttribute("result", "shape");
      filter.appendChild(feB2);
      defs.appendChild(filter);
      const clipPath = document.createElementNS(svgNS, "clipPath");
      clipPath.setAttribute("id", "clip0_hive");
      const rect = document.createElementNS(svgNS, "rect");
      rect.setAttribute("width", "16");
      rect.setAttribute("height", "16");
      rect.setAttribute("fill", "white");
      clipPath.appendChild(rect);
      defs.appendChild(clipPath);
      cursor.appendChild(defs);
      cursor.appendChild(gClip);
      return cursor;
    }, isInspectElement = function(el) {
      return !!el && !!el.getAttribute && el.getAttribute("data-opendevs-inspect") === "true";
    }, getReactProps = function(el) {
      try {
        const keys = Object.keys(el);
        let fiberKey = null;
        for (let i = 0; i < keys.length; i++) {
          if (keys[i].indexOf("__reactFiber") === 0 || keys[i].indexOf("__reactInternalInstance") === 0) {
            fiberKey = keys[i];
            break;
          }
        }
        if (!fiberKey) return null;
        let fiber = el[fiberKey];
        while (fiber) {
          const type = fiber.elementType || fiber.type;
          if (type && typeof type !== "string") {
            const name = typeof type === "function" ? type.displayName || type.name : type.render?.displayName || type.render?.name || type.type?.displayName || type.type?.name;
            if (name) break;
          }
          fiber = fiber.return;
        }
        if (!fiber) return null;
        const raw = fiber.memoizedProps || fiber.pendingProps;
        if (!raw || typeof raw !== "object") return null;
        const result = {};
        let totalLen = 0;
        const MAX_LEN = 500;
        for (const key of Object.keys(raw)) {
          if (totalLen >= MAX_LEN) break;
          if (SKIP_PROP_KEYS.indexOf(key) !== -1) continue;
          if (key.startsWith("on") || key.startsWith("__")) continue;
          const val = raw[key];
          const t = typeof val;
          if (t === "string") {
            if (val.length > 100) continue;
            result[key] = val;
            totalLen += key.length + val.length + 3;
          } else if (t === "number" || t === "boolean") {
            const s = String(val);
            result[key] = s;
            totalLen += key.length + s.length + 3;
          } else if (val === null || val === void 0) {
          } else if (t === "object" && !Array.isArray(val)) {
            try {
              const json = JSON.stringify(val);
              if (json.length <= 80) {
                result[key] = json;
                totalLen += key.length + json.length + 3;
              }
            } catch (_) {
            }
          }
        }
        return Object.keys(result).length > 0 ? result : null;
      } catch (_e) {
        return null;
      }
    }, getFilteredAttributes = function(el) {
      const result = {};
      for (let i = 0; i < ATTR_WHITELIST.length; i++) {
        const attr = ATTR_WHITELIST[i];
        const val = el.getAttribute(attr);
        if (val !== null && val !== "") {
          result[attr] = val.length > 100 ? val.substring(0, 100) : val;
        }
      }
      const attrs = el.attributes;
      if (attrs) {
        for (let i = 0; i < attrs.length; i++) {
          const name = attrs[i].name;
          if (name.startsWith("data-") && !result[name] && name !== "data-opendevs-ref" && name !== "data-opendevs-inspect") {
            if (name.indexOf("test") !== -1 || name.indexOf("state") !== -1 || name.indexOf("variant") !== -1 || name.indexOf("status") !== -1) {
              result[name] = attrs[i].value.substring(0, 100);
            }
          }
        }
      }
      return Object.keys(result).length > 0 ? result : null;
    }, getShallowInnerHTML = function(el) {
      try {
        const html = el.innerHTML;
        if (!html || html.length === 0) return null;
        if (html.length <= 500) return html.trim();
        let truncated = html.substring(0, 500);
        const lastClose = truncated.lastIndexOf(">");
        if (lastClose > 400) truncated = truncated.substring(0, lastClose + 1);
        return truncated.trim() + "...";
      } catch (_e) {
        return null;
      }
    }, enableSelectionMode = function() {
      if (selectionMode) return;
      selectionMode = true;
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
        overlay.setAttribute("data-opendevs-inspect", "true");
        overlay.style.cssText = "position:fixed;background:rgba(58,150,221,0.3);border:2px solid #3a96dd;pointer-events:none;z-index:2147483647;transition:all 0.1s ease;display:none;";
        document.body.appendChild(overlay);
        overlayLabel = document.createElement("div");
        overlayLabel.setAttribute("data-opendevs-inspect", "true");
        overlayLabel.style.cssText = "position:fixed;background:#3a96dd;color:white;padding:2px 6px;font-size:11px;font-family:system-ui,-apple-system,sans-serif;font-weight:500;border-radius:2px;pointer-events:none;z-index:2147483648;transition:all 0.1s ease;white-space:nowrap;display:none;";
        document.body.appendChild(overlayLabel);
      }
      document.addEventListener("mousedown", handleMouseDown, true);
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp, true);
      document.addEventListener("click", handleClick, true);
      document.addEventListener("keydown", handleKeyDown, true);
      sendToFrontend("selection-mode", { active: true });
    }, disableSelectionMode = function() {
      if (!selectionMode) return;
      selectionMode = false;
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
    }, handleMouseDown = function(e) {
      if (!selectionMode) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      isDragging = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      if (overlay) overlay.style.display = "none";
      if (overlayLabel) overlayLabel.style.display = "none";
      if (selectionCursor) selectionCursor.style.display = "none";
      if (!dragSelectionBox) {
        dragSelectionBox = document.createElement("div");
        dragSelectionBox.setAttribute("data-opendevs-inspect", "true");
        dragSelectionBox.style.cssText = "position:fixed;background:rgba(58,150,221,0.1);border:2px dashed #3a96dd;pointer-events:none;z-index:2147483647;";
        document.body.appendChild(dragSelectionBox);
      }
      dragSelectionBox.style.left = dragStartX + "px";
      dragSelectionBox.style.top = dragStartY + "px";
      dragSelectionBox.style.width = "0px";
      dragSelectionBox.style.height = "0px";
    }, handleMouseMove = function(e) {
      if (!selectionMode) return;
      if (selectionCursor) {
        selectionCursor.style.left = e.clientX + "px";
        selectionCursor.style.top = e.clientY + "px";
      }
      if (isDragging && dragSelectionBox) {
        const left = Math.min(dragStartX, e.clientX);
        const top = Math.min(dragStartY, e.clientY);
        const width = Math.abs(e.clientX - dragStartX);
        const height = Math.abs(e.clientY - dragStartY);
        dragSelectionBox.style.left = left + "px";
        dragSelectionBox.style.top = top + "px";
        dragSelectionBox.style.width = width + "px";
        dragSelectionBox.style.height = height + "px";
      } else if (!isDragging && overlay && overlayLabel) {
        const composed = e.composedPath ? e.composedPath() : [];
        let element = null;
        for (let pi = 0; pi < composed.length; pi++) {
          const node = composed[pi];
          if (node.nodeType === 1 && !isInspectElement(node)) {
            element = node;
            break;
          }
        }
        if (!element) element = document.elementFromPoint(e.clientX, e.clientY);
        if (element && !isInspectElement(element)) {
          const rect = element.getBoundingClientRect();
          overlay.style.display = "";
          overlay.style.left = rect.left + "px";
          overlay.style.top = rect.top + "px";
          overlay.style.width = rect.width + "px";
          overlay.style.height = rect.height + "px";
          const tagName = element.tagName.toLowerCase();
          const dims = Math.round(rect.width) + "\xD7" + Math.round(rect.height);
          const reactInfo = getReactComponentInfo(element);
          let label = "";
          if (reactInfo.componentName) {
            label = "\u269B " + reactInfo.componentName + " \u2022 " + dims;
          } else {
            const htmlEl = element;
            const id = htmlEl.id;
            const testId = htmlEl.getAttribute("data-testid") || htmlEl.getAttribute("data-test-id");
            const role = htmlEl.getAttribute("role");
            const ariaLabel = htmlEl.getAttribute("aria-label");
            let ident = "";
            if (id) {
              ident = "#" + id;
            } else if (testId) {
              ident = '[data-testid="' + testId + '"]';
            } else if (role) {
              ident = '[role="' + role + '"]';
            } else if (ariaLabel) {
              ident = '[aria-label="' + ariaLabel.substring(0, 20) + (ariaLabel.length > 20 ? "..." : "") + '"]';
            } else {
              const classes = htmlEl.className ? String(htmlEl.className).split(" ").filter(Boolean) : [];
              let meaningful = null;
              for (let ci = 0; ci < classes.length; ci++) {
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
          const labelTop = rect.top > 20 ? rect.top - 20 : rect.top + 2;
          overlayLabel.style.left = rect.left + "px";
          overlayLabel.style.top = labelTop + "px";
        }
      }
    }, captureElement = function(clientX, clientY) {
      let element = document.elementFromPoint(clientX, clientY);
      if (!element || isInspectElement(element)) return;
      while (element && element.nodeType !== 1) element = element.parentElement;
      if (!element || !element.tagName) return;
      const rect = element.getBoundingClientRect();
      const cs = window.getComputedStyle(element);
      const pathParts = [];
      let cur = element;
      while (cur && cur !== document.body) {
        let seg = cur.tagName.toLowerCase();
        if (cur.id) {
          seg += "#" + cur.id;
        } else {
          if (cur.className && typeof cur.className === "string") {
            const classes = cur.className.trim().split(/\s+/);
            for (let ci = 0; ci < classes.length; ci++) {
              if (!TAILWIND_PATTERN.test(classes[ci])) {
                seg += "." + classes[ci];
                break;
              }
            }
          }
          if (cur.parentElement) {
            const siblings = cur.parentElement.children;
            let sameTagCount = 0;
            let selfIndex = 0;
            for (let sib = 0; sib < siblings.length; sib++) {
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
      const reactInfo = getReactComponentInfo(element);
      const ref = getOrAssignElementId(element);
      let className = "";
      if (typeof element.className === "string") {
        const classes = element.className.trim().split(/\s+/);
        const semantic = [];
        for (let ci = 0; ci < classes.length; ci++) {
          if (classes[ci] && !TAILWIND_PATTERN.test(classes[ci])) {
            semantic.push(classes[ci]);
          }
        }
        className = semantic.join(" ");
        if (className.length > 200) className = className.substring(0, 200);
      }
      let text = element.innerText || "";
      if (!text) {
        const accName = computeAccessibleName(element);
        if (accName) text = accName;
        else text = element.textContent || "";
      }
      if (text.length > 200) text = text.substring(0, 200);
      const host = window.location.hostname;
      const context = host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" ? "local" : "external";
      const styles = {};
      const varDecls = getMatchedVarDeclarations(element);
      if (context === "local") {
        const localProps = [
          "background-color",
          "color",
          "border-color",
          "font-size",
          "font-weight",
          "border-radius",
          "padding",
          "gap"
        ];
        for (let sp = 0; sp < localProps.length; sp++) {
          const prop = localProps[sp];
          const varVal = varDecls[prop];
          if (varVal) {
            styles[prop] = varVal;
          } else {
            const compVal = cs.getPropertyValue(prop);
            if ((prop === "font-size" || prop === "border-radius" || prop === "font-weight") && compVal && compVal !== "0px" && compVal !== "none" && compVal !== "normal") {
              styles[prop] = compVal;
            }
          }
        }
      } else {
        const externalProps = [
          "background-color",
          "color",
          "font-size",
          "font-weight",
          "font-family",
          "border-radius",
          "padding",
          "gap",
          "box-shadow",
          "opacity"
        ];
        for (let sp = 0; sp < externalProps.length; sp++) {
          const prop = externalProps[sp];
          const val = varDecls[prop] || cs.getPropertyValue(prop);
          if (val && val !== "none" && val !== "normal" && val !== "0px" && val !== "rgba(0, 0, 0, 0)" && val !== "transparent" && val !== "auto") {
            let finalVal = val;
            if ((prop === "background-color" || prop === "color") && val.indexOf("var(") === -1) {
              const hex = convertColorToHex(val);
              if (hex) finalVal = hex;
            }
            styles[prop] = finalVal;
          }
        }
      }
      let pathStr = pathParts.join(" > ");
      if (pathStr.length > 500) pathStr = pathStr.substring(pathStr.length - 500);
      const reactProps = context === "local" ? getReactProps(element) : null;
      const htmlAttrs = getFilteredAttributes(element);
      const innerHTML = context === "local" ? getShallowInnerHTML(element) : null;
      sendToFrontend("element-event", {
        type: "element-selected",
        ref,
        context,
        element: {
          tagName: element.tagName,
          id: element.id || void 0,
          className: className || void 0,
          innerText: text || void 0,
          path: pathStr,
          rect: {
            top: Math.round(rect.top),
            left: Math.round(rect.left),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          },
          styles,
          props: reactProps || void 0,
          attributes: htmlAttrs || void 0,
          innerHTML: innerHTML || void 0
        },
        reactComponent: reactInfo.componentName ? {
          name: reactInfo.componentName,
          fileName: reactInfo.fileName,
          lineNumber: reactInfo.lineNumber
        } : void 0,
        url: window.location.href,
        timestamp: Date.now()
      });
    }, handleMouseUp = function(e) {
      if (!selectionMode) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (isDragging) {
        const width = Math.abs(e.clientX - dragStartX);
        const height = Math.abs(e.clientY - dragStartY);
        if (width > 5 || height > 5) {
          const left = Math.min(dragStartX, e.clientX);
          const top = Math.min(dragStartY, e.clientY);
          sendToFrontend("element-event", {
            type: "area-selected",
            bounds: {
              x: Math.round(left),
              y: Math.round(top),
              width: Math.round(width),
              height: Math.round(height)
            },
            url: window.location.href,
            timestamp: Date.now()
          });
        } else {
          captureElement(dragStartX, dragStartY);
        }
        if (dragSelectionBox) {
          dragSelectionBox.remove();
          dragSelectionBox = null;
        }
        isDragging = false;
        if (selectionCursor) selectionCursor.style.display = "";
      }
    }, handleClick = function(e) {
      if (!selectionMode) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    }, handleKeyDown = function(e) {
      if (!selectionMode) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (e.key === "Escape") {
        disableSelectionMode();
      }
    };
    sendToFrontend2 = sendToFrontend, getOrAssignElementId2 = getOrAssignElementId, getReactComponentInfo2 = getReactComponentInfo, computeAccessibleName2 = computeAccessibleName, convertColorToHex2 = convertColorToHex, getMatchedVarDeclarations2 = getMatchedVarDeclarations, createSelectionCursor2 = createSelectionCursor, isInspectElement2 = isInspectElement, getReactProps2 = getReactProps, getFilteredAttributes2 = getFilteredAttributes, getShallowInnerHTML2 = getShallowInnerHTML, enableSelectionMode2 = enableSelectionMode, disableSelectionMode2 = disableSelectionMode, handleMouseDown2 = handleMouseDown, handleMouseMove2 = handleMouseMove, captureElement2 = captureElement, handleMouseUp2 = handleMouseUp, handleClick2 = handleClick, handleKeyDown2 = handleKeyDown;
    window.__opendevsInspectMode = true;
    let selectionMode = false;
    let overlay = null;
    let overlayLabel = null;
    let selectionCursor = null;
    let cursorStyleOverride = null;
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let dragSelectionBox = null;
    let elementIdCounter = 0;
    const eventBuffer = [];
    window.__OPENDEVS_INSPECT_EVENTS__ = eventBuffer;
    let colorCanvas = null;
    let colorCtx = null;
    const varDeclCache = /* @__PURE__ */ new WeakMap();
    const VAR_CACHE_TTL = 2e3;
    const TAILWIND_PATTERN = /^(flex|grid|p-|m-|text-|bg-|border|rounded|w-|h-|gap-|items-|justify-|overflow-|opacity-|transition|duration|ease|hover:|focus:|active:|dark:|hidden|block|inline|relative|absolute|fixed|sticky|min-|max-|space-|divide-|ring-|shadow-|sr-|not-|group|peer|placeholder-|disabled:|data-|aria-|sm:|md:|lg:|xl:|2xl:|\[|!)/;
    const SKIP_PROP_KEYS = [
      "children",
      "ref",
      "key",
      "__self",
      "__source",
      "className",
      "style",
      "dangerouslySetInnerHTML"
    ];
    const ATTR_WHITELIST = [
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
      "method"
    ];
    window.__opendevsInspect = {
      enable: enableSelectionMode,
      disable: disableSelectionMode,
      isActive: () => selectionMode,
      /** Drain all buffered events and return them as a JSON string.
       *  Called by the React side via eval_browser_webview_with_result. */
      drainEvents: () => {
        const events = eventBuffer.splice(0, eventBuffer.length);
        return JSON.stringify(events);
      }
    };
    console.log("[opendevs-inspect] SETUP complete \u2014 window.__opendevsInspect installed");
  }
  var sendToFrontend2;
  var getOrAssignElementId2;
  var getReactComponentInfo2;
  var computeAccessibleName2;
  var convertColorToHex2;
  var getMatchedVarDeclarations2;
  var createSelectionCursor2;
  var isInspectElement2;
  var getReactProps2;
  var getFilteredAttributes2;
  var getShallowInnerHTML2;
  var enableSelectionMode2;
  var disableSelectionMode2;
  var handleMouseDown2;
  var handleMouseMove2;
  var captureElement2;
  var handleMouseUp2;
  var handleClick2;
  var handleKeyDown2;
})();
