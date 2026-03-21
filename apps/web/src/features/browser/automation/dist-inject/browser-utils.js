"use strict";
(() => {
  // apps/web/src/features/browser/automation/inject/browser-utils.ts
  if (!window.__opendevsBrowserUtils) {
    let getTextFromIds = function(ids) {
      if (!ids) return "";
      return ids.split(" ").map((id) => {
        const el = document.getElementById(id);
        return el ? (el.textContent || "").trim() : "";
      }).filter(Boolean).join(" ");
    }, getVisibleText = function(el) {
      try {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
          acceptNode(node) {
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            const style = window.getComputedStyle(parent);
            if (style.display === "none" || style.visibility === "hidden")
              return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          }
        });
        let text = "";
        while (walker.nextNode()) {
          text += " " + walker.currentNode.textContent;
          if (text.length > 200) break;
        }
        return text.replace(/\s+/g, " ").trim().substring(0, 200);
      } catch (_e) {
        const raw = el.innerText || el.textContent || "";
        return raw.replace(/\s+/g, " ").trim().substring(0, 200);
      }
    }, getLabelsText = function(el) {
      try {
        const labeled = el;
        if (!labeled.labels || !labeled.labels.length) return "";
        return Array.from(labeled.labels).map((l) => {
          return getVisibleText(l);
        }).filter(Boolean).join(" ").substring(0, 200);
      } catch (_e) {
        return "";
      }
    }, getImplicitRole = function(el) {
      const tag = el.tagName.toLowerCase();
      switch (tag) {
        case "a":
          return el.hasAttribute("href") ? "link" : "generic";
        case "button":
        case "summary":
          return "button";
        case "input": {
          const t = (el.type || "text").toLowerCase();
          if (t === "button" || t === "submit" || t === "reset" || t === "image") return "button";
          if (t === "checkbox") return "checkbox";
          if (t === "radio") return "radio";
          if (t === "range") return "slider";
          if (t === "number") return "spinbutton";
          return "textbox";
        }
        case "select": {
          const sel = el;
          return sel.multiple || sel.size && sel.size > 1 ? "listbox" : "combobox";
        }
        case "option":
          return "option";
        case "textarea":
          return "textbox";
        case "img":
        case "svg":
          return "img";
        case "h1":
        case "h2":
        case "h3":
        case "h4":
        case "h5":
        case "h6":
          return "heading";
        case "ul":
        case "ol":
          return "list";
        case "li":
          return "listitem";
        case "nav":
          return "navigation";
        case "main":
          return "main";
        case "header":
          return "banner";
        case "footer":
          return "contentinfo";
        case "form":
          return "form";
        case "table":
          return "table";
        case "tr":
          return "row";
        case "td":
          return "cell";
        case "th":
          return "columnheader";
        case "section":
          return "section";
        case "article":
          return "article";
        case "aside":
          return "aside";
        case "details":
          return "group";
        case "progress":
          return "progressbar";
        case "meter":
          return "meter";
        case "label":
          return "label";
        default:
          return "generic";
      }
    }, computeAccessibleName = function(el, role) {
      if (el.getAttribute("aria-hidden") === "true") return "";
      const labelledBy = el.getAttribute("aria-labelledby");
      if (labelledBy) {
        const t = getTextFromIds(labelledBy);
        if (t) return t.substring(0, 200);
      }
      const ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel) return ariaLabel.substring(0, 200);
      const placeholder = el.getAttribute("aria-placeholder");
      if (placeholder) return placeholder.substring(0, 200);
      const labels = getLabelsText(el);
      if (labels) return labels;
      const tag = el.tagName.toLowerCase();
      if (tag === "img") {
        const alt = el.getAttribute("alt");
        if (alt) return alt.substring(0, 200);
      }
      if (tag === "input") {
        const inp = el;
        if (["button", "submit", "reset"].includes((inp.type || "").toLowerCase())) {
          if (inp.value) return inp.value.substring(0, 200);
        }
        return (inp.placeholder || inp.value || "").substring(0, 200);
      }
      if (tag === "textarea") {
        const ta = el;
        return (ta.placeholder || ta.value || "").substring(0, 200);
      }
      if (tag === "select") {
        const sel = el;
        const opts = Array.from(sel.selectedOptions || []).map((o) => o.text);
        if (opts.length) return opts.join(", ").substring(0, 200);
      }
      const interactiveTags = [
        "button",
        "a",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "label",
        "p",
        "li",
        "summary"
      ];
      if (interactiveTags.includes(tag) || role === "button" || role === "link" || role === "heading") {
        return getVisibleText(el);
      }
      const title = el.getAttribute("title");
      if (title) return title.substring(0, 200);
      return "";
    }, collectElementStates = function(el, _role) {
      const states = [];
      try {
        if (el.matches(":focus")) states.push("focused");
        if (el.matches(":disabled")) states.push("disabled");
        if (el.checked) states.push("checked");
        if (el.required) states.push("required");
        if (el.readOnly) states.push("readonly");
        if (el.selected) states.push("selected");
      } catch (_e) {
      }
      const ariaStates = {
        "aria-selected": "selected",
        "aria-expanded": null,
        "aria-pressed": "pressed",
        "aria-current": "current",
        "aria-invalid": "invalid",
        "aria-busy": "busy"
      };
      for (const attr in ariaStates) {
        const val = el.getAttribute(attr);
        if (val && val !== "false") {
          if (attr === "aria-expanded") states.push(val === "true" ? "expanded" : "collapsed");
          else states.push(ariaStates[attr] || attr.replace("aria-", ""));
        }
      }
      return [...new Set(states)];
    }, collectElementDetails = function(el, _role) {
      const details = {};
      let desc = el.getAttribute("aria-description") || "";
      const descBy = el.getAttribute("aria-describedby");
      if (descBy) desc = (desc + " " + getTextFromIds(descBy)).trim();
      if (desc) details.description = desc.substring(0, 200);
      const tag = el.tagName.toLowerCase();
      if (tag === "a" && el.href) details.url = el.href;
      if ((tag === "img" || tag === "svg") && el.src)
        details.src = el.src;
      if (tag === "input" || tag === "textarea") {
        const inp = el;
        if ((inp.type || "").toLowerCase() !== "password") {
          if (inp.value) details.value = inp.value.substring(0, 200);
        }
        if (inp.placeholder) details.placeholder = inp.placeholder.substring(0, 200);
      }
      if (tag === "select") {
        const sel = el;
        const opts = Array.from(sel.selectedOptions || []).map((o) => o.text);
        if (opts.length) details.value = opts.join(", ").substring(0, 200);
      }
      return details;
    }, shouldIncludeElement = function(el) {
      if (el.getAttribute("aria-hidden") === "true") return false;
      const tag = el.tagName.toLowerCase();
      const includeTags = [
        "a",
        "button",
        "input",
        "select",
        "textarea",
        "img",
        "svg",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "nav",
        "main",
        "header",
        "footer",
        "section",
        "article",
        "form",
        "label",
        "ul",
        "ol",
        "li",
        "p",
        "summary",
        "details"
      ];
      if (includeTags.includes(tag)) return true;
      const role = el.getAttribute("role");
      if (role && role !== "generic" && role !== "presentation" && role !== "none") return true;
      if (el.getAttribute("aria-label") || el.getAttribute("aria-labelledby")) return true;
      if (el.contentEditable === "true") return true;
      if (el.querySelector("a,button,input,select,textarea")) return true;
      return false;
    }, buildAccessibilityTree = function(element, depth, maxDepth) {
      if (depth > maxDepth || __nodeCount >= __NODE_LIMIT) return null;
      __nodeCount++;
      let ref = element.getAttribute("data-opendevs-ref");
      if (!ref) {
        ref = "ref-" + Math.random().toString(36).substring(2, 15);
        element.setAttribute("data-opendevs-ref", ref);
      }
      const role = element.getAttribute("role") || getImplicitRole(element);
      const name = computeAccessibleName(element, role);
      const states = collectElementStates(element, role);
      const details = collectElementDetails(element, role);
      const node = { ref, role, name };
      const tag = element.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) node.level = parseInt(tag[1]);
      if (states.length) node.states = states;
      Object.assign(node, details);
      const children = [];
      for (let i = 0; i < element.children.length && __nodeCount < __NODE_LIMIT; i++) {
        const child = element.children[i];
        if (shouldIncludeElement(child)) {
          const childNode = buildAccessibilityTree(child, depth + 1, maxDepth);
          if (childNode) children.push(childNode);
        }
      }
      if (children.length) node.children = children;
      return node;
    }, buildPageSnapshot = function() {
      __nodeCount = 0;
      return buildAccessibilityTree(document.body, 0, 20);
    }, accessibilityTreeToYaml = function(node, indent) {
      indent = indent || 0;
      if (!node) return "";
      const pad = "  ".repeat(indent);
      const lines = [];
      lines.push(pad + "- role: " + node.role);
      if (node.name) {
        const escaped = /[:"\\[]/.test(node.name) ? '"' + node.name.replace(/"/g, '\\"') + '"' : node.name;
        lines.push(pad + "  name: " + escaped);
      }
      lines.push(pad + "  ref: " + node.ref);
      if (node.level) lines.push(pad + "  level: " + node.level);
      if (node.states && node.states.length)
        lines.push(pad + "  states: [" + node.states.join(", ") + "]");
      if (node.url) lines.push(pad + "  url: " + node.url);
      if (node.value) lines.push(pad + "  value: " + node.value);
      if (node.placeholder) lines.push(pad + "  placeholder: " + node.placeholder);
      if (node.description) lines.push(pad + "  description: " + node.description);
      if (node.children && node.children.length) {
        lines.push(pad + "  children:");
        for (let i = 0; i < node.children.length; i++) {
          lines.push(accessibilityTreeToYaml(node.children[i], indent + 2));
        }
      }
      return lines.join("\n");
    }, findElementByRef = function(ref) {
      return document.querySelector('[data-opendevs-ref="' + ref + '"]');
    }, scrollIntoViewIfNeeded = function(el) {
      const rect = el.getBoundingClientRect();
      const inView = rect.top >= 0 && rect.left >= 0 && rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) && rect.right <= (window.innerWidth || document.documentElement.clientWidth);
      if (!inView) el.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
    }, getElementCenter = function(el) {
      const rect = el.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    }, simulateClick = function(el, opts) {
      const options = opts || {};
      scrollIntoViewIfNeeded(el);
      const center = getElementCenter(el);
      const eventOpts = {
        bubbles: true,
        cancelable: true,
        view: window,
        button: 0,
        buttons: 1,
        clientX: center.x,
        clientY: center.y,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: false
      };
      el.focus();
      el.dispatchEvent(new MouseEvent("mousedown", eventOpts));
      el.dispatchEvent(new MouseEvent("mouseup", eventOpts));
      el.dispatchEvent(new MouseEvent("click", eventOpts));
      if (options.doubleClick) {
        el.dispatchEvent(new MouseEvent("mousedown", eventOpts));
        el.dispatchEvent(new MouseEvent("mouseup", eventOpts));
        el.dispatchEvent(new MouseEvent("click", eventOpts));
        el.dispatchEvent(new MouseEvent("dblclick", eventOpts));
      }
    }, simulateType = function(el, text, opts) {
      const options = opts || {};
      scrollIntoViewIfNeeded(el);
      el.focus();
      if (el.contentEditable === "true") {
        el.textContent = text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        const nativeSetter = Object.getOwnPropertyDescriptor(
          el.tagName.toLowerCase() === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
          "value"
        );
        if (nativeSetter && nativeSetter.set) {
          nativeSetter.set.call(el, text);
        } else {
          el.value = text;
        }
        el.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            cancelable: true,
            data: text,
            inputType: "insertText"
          })
        );
      }
      el.dispatchEvent(new Event("change", { bubbles: true }));
      if (options.submit) {
        el.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true })
        );
        el.dispatchEvent(
          new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true })
        );
        const form = el.closest && el.closest("form");
        if (form) {
          if (form.requestSubmit) {
            form.requestSubmit();
          } else {
            form.submit();
          }
        }
      }
    }, waitForDomSettle = function(quietMs, maxMs) {
      const quiet = quietMs || 150;
      const max = maxMs || 2e3;
      return new Promise((resolve) => {
        let timer = null;
        let maxTimer = null;
        const observer = new MutationObserver(() => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            observer.disconnect();
            if (maxTimer) clearTimeout(maxTimer);
            resolve();
          }, quiet);
        });
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true
        });
        timer = setTimeout(() => {
          observer.disconnect();
          if (maxTimer) clearTimeout(maxTimer);
          resolve();
        }, quiet);
        maxTimer = setTimeout(() => {
          observer.disconnect();
          if (timer) clearTimeout(timer);
          resolve();
        }, max);
      });
    };
    getTextFromIds2 = getTextFromIds, getVisibleText2 = getVisibleText, getLabelsText2 = getLabelsText, getImplicitRole2 = getImplicitRole, computeAccessibleName2 = computeAccessibleName, collectElementStates2 = collectElementStates, collectElementDetails2 = collectElementDetails, shouldIncludeElement2 = shouldIncludeElement, buildAccessibilityTree2 = buildAccessibilityTree, buildPageSnapshot2 = buildPageSnapshot, accessibilityTreeToYaml2 = accessibilityTreeToYaml, findElementByRef2 = findElementByRef, scrollIntoViewIfNeeded2 = scrollIntoViewIfNeeded, getElementCenter2 = getElementCenter, simulateClick2 = simulateClick, simulateType2 = simulateType, waitForDomSettle2 = waitForDomSettle;
    let __nodeCount = 0;
    const __NODE_LIMIT = 3e3;
    window.__opendevsBrowserUtils = {
      buildPageSnapshot,
      accessibilityTreeToYaml,
      findElementByRef,
      scrollIntoViewIfNeeded,
      getElementCenter,
      simulateClick,
      simulateType,
      waitForDomSettle
    };
  }
  var getTextFromIds2;
  var getVisibleText2;
  var getLabelsText2;
  var getImplicitRole2;
  var computeAccessibleName2;
  var collectElementStates2;
  var collectElementDetails2;
  var shouldIncludeElement2;
  var buildAccessibilityTree2;
  var buildPageSnapshot2;
  var accessibilityTreeToYaml2;
  var findElementByRef2;
  var scrollIntoViewIfNeeded2;
  var getElementCenter2;
  var simulateClick2;
  var simulateType2;
  var waitForDomSettle2;
})();
