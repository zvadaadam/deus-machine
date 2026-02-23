// inject/browser-utils.ts
// Core browser automation utilities — runs inside WKWebView page context.
//
// Compiled by esbuild into a self-contained IIFE (see build-inject.ts).
// When eval'd, installs utilities on window.__hiveBrowserUtils:
// - Accessibility tree builder (buildPageSnapshot, accessibilityTreeToYaml)
// - Element finder (findElementByRef)
// - Event simulation (simulateClick, simulateType)
// - DOM settle detection (waitForDomSettle)
// - Scroll helpers (scrollIntoViewIfNeeded, getElementCenter)
//
// These are injected ONCE on page load. Action builder functions
// (buildClickJs, buildTypeJs, etc.) reference window.__hiveBrowserUtils
// instead of embedding ~390 lines of utilities per call.

// Guard: prevent double-injection
if (!(window as any).__hiveBrowserUtils) {

  // ========================================================================
  // Accessibility Tree Builder
  // ========================================================================

  function getTextFromIds(ids: string): string {
    if (!ids) return '';
    return ids.split(' ').map((id) => {
      const el = document.getElementById(id);
      return el ? (el.textContent || '').trim() : '';
    }).filter(Boolean).join(' ');
  }

  function getVisibleText(el: Element): string {
    try {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          const style = window.getComputedStyle(parent);
          if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      let text = '';
      while (walker.nextNode()) {
        text += ' ' + walker.currentNode.textContent;
        if (text.length > 200) break;
      }
      return text.replace(/\s+/g, ' ').trim().substring(0, 200);
    } catch (_e) {
      const raw = (el as HTMLElement).innerText || el.textContent || '';
      return raw.replace(/\s+/g, ' ').trim().substring(0, 200);
    }
  }

  function getLabelsText(el: HTMLElement): string {
    try {
      const labeled = el as HTMLInputElement;
      if (!labeled.labels || !labeled.labels.length) return '';
      return Array.from(labeled.labels).map((l) => {
        return getVisibleText(l);
      }).filter(Boolean).join(' ').substring(0, 200);
    } catch (_e) { return ''; }
  }

  function getImplicitRole(el: Element): string {
    const tag = el.tagName.toLowerCase();
    switch (tag) {
      case 'a': return el.hasAttribute('href') ? 'link' : 'generic';
      case 'button': case 'summary': return 'button';
      case 'input': {
        const t = ((el as HTMLInputElement).type || 'text').toLowerCase();
        if (t === 'button' || t === 'submit' || t === 'reset' || t === 'image') return 'button';
        if (t === 'checkbox') return 'checkbox';
        if (t === 'radio') return 'radio';
        if (t === 'range') return 'slider';
        if (t === 'number') return 'spinbutton';
        return 'textbox';
      }
      case 'select': {
        const sel = el as HTMLSelectElement;
        return (sel.multiple || (sel.size && sel.size > 1)) ? 'listbox' : 'combobox';
      }
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

  function computeAccessibleName(el: Element, role: string): string {
    if (el.getAttribute('aria-hidden') === 'true') return '';
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) { const t = getTextFromIds(labelledBy); if (t) return t.substring(0, 200); }
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel.substring(0, 200);
    const placeholder = el.getAttribute('aria-placeholder');
    if (placeholder) return placeholder.substring(0, 200);
    const labels = getLabelsText(el as HTMLElement);
    if (labels) return labels;
    const tag = el.tagName.toLowerCase();
    if (tag === 'img') { const alt = el.getAttribute('alt'); if (alt) return alt.substring(0, 200); }
    if (tag === 'input') {
      const inp = el as HTMLInputElement;
      if (['button', 'submit', 'reset'].includes((inp.type || '').toLowerCase())) {
        if (inp.value) return inp.value.substring(0, 200);
      }
      return (inp.placeholder || inp.value || '').substring(0, 200);
    }
    if (tag === 'textarea') {
      const ta = el as HTMLTextAreaElement;
      return (ta.placeholder || ta.value || '').substring(0, 200);
    }
    if (tag === 'select') {
      const sel = el as HTMLSelectElement;
      const opts = Array.from(sel.selectedOptions || []).map((o) => o.text);
      if (opts.length) return opts.join(', ').substring(0, 200);
    }
    const interactiveTags = ['button', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'label', 'p', 'li', 'summary'];
    if (interactiveTags.includes(tag) || role === 'button' || role === 'link' || role === 'heading') {
      return getVisibleText(el);
    }
    const title = el.getAttribute('title');
    if (title) return title.substring(0, 200);
    return '';
  }

  function collectElementStates(el: Element, _role: string): string[] {
    const states: string[] = [];
    try {
      if (el.matches(':focus')) states.push('focused');
      if (el.matches(':disabled')) states.push('disabled');
      if ((el as HTMLInputElement).checked) states.push('checked');
      if ((el as HTMLInputElement).required) states.push('required');
      if ((el as HTMLInputElement).readOnly) states.push('readonly');
      if ((el as HTMLOptionElement).selected) states.push('selected');
    } catch (_e) { /* swallow */ }
    const ariaStates: Record<string, string | null> = {
      'aria-selected': 'selected', 'aria-expanded': null, 'aria-pressed': 'pressed',
      'aria-current': 'current', 'aria-invalid': 'invalid', 'aria-busy': 'busy',
    };
    for (const attr in ariaStates) {
      const val = el.getAttribute(attr);
      if (val && val !== 'false') {
        if (attr === 'aria-expanded') states.push(val === 'true' ? 'expanded' : 'collapsed');
        else states.push(ariaStates[attr] || attr.replace('aria-', ''));
      }
    }
    return [...new Set(states)];
  }

  function collectElementDetails(el: Element, _role: string): Record<string, any> {
    const details: Record<string, any> = {};
    let desc = el.getAttribute('aria-description') || '';
    const descBy = el.getAttribute('aria-describedby');
    if (descBy) desc = (desc + ' ' + getTextFromIds(descBy)).trim();
    if (desc) details.description = desc.substring(0, 200);
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' && (el as HTMLAnchorElement).href) details.url = (el as HTMLAnchorElement).href;
    if ((tag === 'img' || tag === 'svg') && (el as HTMLImageElement).src) details.src = (el as HTMLImageElement).src;
    if (tag === 'input' || tag === 'textarea') {
      const inp = el as HTMLInputElement;
      if ((inp.type || '').toLowerCase() !== 'password') {
        if (inp.value) details.value = inp.value.substring(0, 200);
      }
      if (inp.placeholder) details.placeholder = inp.placeholder.substring(0, 200);
    }
    if (tag === 'select') {
      const sel = el as HTMLSelectElement;
      const opts = Array.from(sel.selectedOptions || []).map((o) => o.text);
      if (opts.length) details.value = opts.join(', ').substring(0, 200);
    }
    return details;
  }

  function shouldIncludeElement(el: Element): boolean {
    if (el.getAttribute('aria-hidden') === 'true') return false;
    const tag = el.tagName.toLowerCase();
    const includeTags = ['a', 'button', 'input', 'select', 'textarea', 'img', 'svg',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'nav', 'main', 'header', 'footer',
      'section', 'article', 'form', 'label', 'ul', 'ol', 'li', 'p', 'summary', 'details'];
    if (includeTags.includes(tag)) return true;
    const role = el.getAttribute('role');
    if (role && role !== 'generic' && role !== 'presentation' && role !== 'none') return true;
    if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) return true;
    if ((el as HTMLElement).contentEditable === 'true') return true;
    if (el.querySelector('a,button,input,select,textarea')) return true;
    return false;
  }

  // Global node counter — caps traversal to prevent timeouts on heavy pages.
  // Reset before each snapshot; shared across recursive calls.
  let __nodeCount = 0;
  const __NODE_LIMIT = 3000;

  function buildAccessibilityTree(element: Element, depth: number, maxDepth: number): any {
    if (depth > maxDepth || __nodeCount >= __NODE_LIMIT) return null;
    __nodeCount++;
    // Assign or reuse data-hive-ref
    let ref = element.getAttribute('data-hive-ref');
    if (!ref) {
      ref = 'ref-' + Math.random().toString(36).substring(2, 15);
      element.setAttribute('data-hive-ref', ref);
    }
    const role = element.getAttribute('role') || getImplicitRole(element);
    const name = computeAccessibleName(element, role);
    const states = collectElementStates(element, role);
    const details = collectElementDetails(element, role);
    const node: any = { ref, role, name };
    // Add heading level
    const tag = element.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) node.level = parseInt(tag[1]);
    if (states.length) node.states = states;
    Object.assign(node, details);
    // Recurse children (bail early if node limit reached)
    const children: any[] = [];
    for (let i = 0; i < element.children.length && __nodeCount < __NODE_LIMIT; i++) {
      const child = element.children[i];
      if (shouldIncludeElement(child)) {
        const childNode = buildAccessibilityTree(child, depth + 1, maxDepth);
        if (childNode) children.push(childNode);
      }
    }
    if (children.length) node.children = children;
    return node;
  }

  function buildPageSnapshot(): any {
    __nodeCount = 0;
    return buildAccessibilityTree(document.body, 0, 20);
  }

  // ========================================================================
  // YAML Formatter (token-efficient output for AI consumption)
  // ========================================================================

  function accessibilityTreeToYaml(node: any, indent: number): string {
    indent = indent || 0;
    if (!node) return '';
    const pad = '  '.repeat(indent);
    const lines: string[] = [];
    lines.push(pad + '- role: ' + node.role);
    if (node.name) {
      const escaped = /[:"\\[]/.test(node.name) ? '"' + node.name.replace(/"/g, '\\"') + '"' : node.name;
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
      for (let i = 0; i < node.children.length; i++) {
        lines.push(accessibilityTreeToYaml(node.children[i], indent + 2));
      }
    }
    return lines.join('\n');
  }

  // ========================================================================
  // Element Interaction Helpers
  // ========================================================================

  function findElementByRef(ref: string): Element | null {
    return document.querySelector('[data-hive-ref="' + ref + '"]');
  }

  function scrollIntoViewIfNeeded(el: Element): void {
    const rect = el.getBoundingClientRect();
    const inView = rect.top >= 0 && rect.left >= 0
      && rect.bottom <= (window.innerHeight || document.documentElement.clientHeight)
      && rect.right <= (window.innerWidth || document.documentElement.clientWidth);
    if (!inView) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
  }

  function getElementCenter(el: Element): { x: number; y: number } {
    const rect = el.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  }

  function simulateClick(el: Element, opts?: { doubleClick?: boolean }): void {
    const options = opts || {};
    scrollIntoViewIfNeeded(el);
    const center = getElementCenter(el);
    const eventOpts = {
      bubbles: true, cancelable: true, view: window,
      button: 0, buttons: 1,
      clientX: center.x, clientY: center.y,
      ctrlKey: false, shiftKey: false, altKey: false, metaKey: false,
    };
    (el as HTMLElement).focus();
    el.dispatchEvent(new MouseEvent('mousedown', eventOpts));
    el.dispatchEvent(new MouseEvent('mouseup', eventOpts));
    el.dispatchEvent(new MouseEvent('click', eventOpts));
    if (options.doubleClick) {
      el.dispatchEvent(new MouseEvent('mousedown', eventOpts));
      el.dispatchEvent(new MouseEvent('mouseup', eventOpts));
      el.dispatchEvent(new MouseEvent('click', eventOpts));
      el.dispatchEvent(new MouseEvent('dblclick', eventOpts));
    }
  }

  function simulateType(el: Element, text: string, opts?: { submit?: boolean }): void {
    const options = opts || {};
    scrollIntoViewIfNeeded(el);
    (el as HTMLElement).focus();
    if ((el as HTMLElement).contentEditable === 'true') {
      el.textContent = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      // Use the native value setter to bypass React's internal value tracker.
      const nativeSetter = Object.getOwnPropertyDescriptor(
        el.tagName.toLowerCase() === 'textarea'
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype,
        'value',
      );
      if (nativeSetter && nativeSetter.set) {
        nativeSetter.set.call(el, text);
      } else {
        (el as HTMLInputElement).value = text;
      }
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true, cancelable: true,
        data: text, inputType: 'insertText',
      }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    if (options.submit) {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      const form = (el as HTMLElement).closest && (el as HTMLElement).closest('form');
      if (form) (form as any).requestSubmit ? (form as any).requestSubmit() : (form as HTMLFormElement).submit();
    }
  }

  // ========================================================================
  // DOM Settle — wait for DOM to stop changing after an action
  // ========================================================================
  function waitForDomSettle(quietMs?: number, maxMs?: number): Promise<void> {
    const quiet = quietMs || 150;
    const max = maxMs || 2000;
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let maxTimer: ReturnType<typeof setTimeout> | null = null;
      const observer = new MutationObserver(() => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          observer.disconnect();
          if (maxTimer) clearTimeout(maxTimer);
          resolve();
        }, quiet);
      });
      observer.observe(document.body, {
        childList: true, subtree: true, attributes: true, characterData: true,
      });
      // Start quiet timer immediately (resolves if no mutations at all)
      timer = setTimeout(() => {
        observer.disconnect();
        if (maxTimer) clearTimeout(maxTimer);
        resolve();
      }, quiet);
      // Hard cap: always resolve by maxMs
      maxTimer = setTimeout(() => {
        observer.disconnect();
        if (timer) clearTimeout(timer);
        resolve();
      }, max);
    });
  }

  // ========================================================================
  // Public API on window
  // ========================================================================
  (window as any).__hiveBrowserUtils = {
    buildPageSnapshot,
    accessibilityTreeToYaml,
    findElementByRef,
    scrollIntoViewIfNeeded,
    getElementCenter,
    simulateClick,
    simulateType,
    waitForDomSettle,
  };
}
