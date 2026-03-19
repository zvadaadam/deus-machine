// inject/visual-effects.ts
// AI visual effects system — runs inside WKWebView page context.
//
// Compiled by esbuild into a self-contained IIFE (see build-inject.ts).
// When eval'd, creates visual feedback for AI browser operations:
// - SVG cursor overlay that moves smoothly to target elements
// - Ripple effect on click (expanding ring with fade-out)
// - Cursor pinning for typing actions (follows element if it moves)
// - Distance-based animation timing (1.5px/ms, 440-1000ms range)
// - Page scan effect ("AI is reading the page")
// - Screenshot flash effect (camera-shutter pop + blue tint)
// - Active glow (breathing edge vignette while AI operates)

// Guard: prevent double-injection
if (!(window as any).__opendevsVisuals) {

  // ========================================================================
  // State
  // ========================================================================
  let cursorEl: SVGSVGElement | null = null;
  let cursorInitialized = false;
  let pinnedEl: Element | null = null;
  let pinRAF: number | null = null;
  let lastX: number | null = null;
  let lastY: number | null = null;
  const OFFSET_X = 6;
  const OFFSET_Y = 6;
  let frameEl: HTMLDivElement | null = null;
  let frameHideTimer: ReturnType<typeof setTimeout> | null = null;
  let activeGlowEl: HTMLDivElement | null = null;
  let activeGlowStyleEl: HTMLStyleElement | null = null;

  // Animation config: distance-based timing with clamped range
  const MIN_MS = 440;
  const MAX_MS = 1000;
  const PX_PER_MS = 1.5;
  const EASING = 'cubic-bezier(0.22, 0.61, 0.36, 1)';

  // ========================================================================
  // Capture Frame — shared rounded-corner border used by scan + screenshot
  // ========================================================================
  function showFrame(rect?: { x: number; y: number; width: number; height: number } | null): void {
    // Cancel any pending hide so rapid calls don't flicker
    if (frameHideTimer) { clearTimeout(frameHideTimer); frameHideTimer = null; }

    if (!frameEl || !frameEl.parentNode) {
      frameEl = document.createElement('div');
      frameEl.setAttribute('data-opendevs-visual', 'true');
      frameEl.style.position = 'fixed';
      frameEl.style.pointerEvents = 'none';
      frameEl.style.zIndex = '2147483646';
      frameEl.style.opacity = '0';
      frameEl.style.transition = 'opacity 150ms ease-out';
      document.documentElement.appendChild(frameEl);
    }

    // Position: region rect (sharp corners) or full viewport (rounded)
    if (rect) {
      const pad = 6;
      frameEl.style.left = (rect.x - pad) + 'px';
      frameEl.style.top = (rect.y - pad) + 'px';
      frameEl.style.right = 'auto';
      frameEl.style.bottom = 'auto';
      frameEl.style.width = (rect.width + pad * 2) + 'px';
      frameEl.style.height = (rect.height + pad * 2) + 'px';
      frameEl.style.borderRadius = '0';
    } else {
      frameEl.style.left = '4px';
      frameEl.style.top = '4px';
      frameEl.style.right = '4px';
      frameEl.style.bottom = '4px';
      frameEl.style.width = 'auto';
      frameEl.style.height = 'auto';
      frameEl.style.borderRadius = '0';
    }
    frameEl.style.border = '3px solid rgba(58, 150, 221, 0.55)';
    frameEl.style.boxShadow = 'inset 0 0 30px rgba(58, 150, 221, 0.06), 0 0 15px rgba(58, 150, 221, 0.08)';
    frameEl.style.transition = 'opacity 150ms ease-out';
    frameEl.style.opacity = '1';
  }

  function hideFrame(delayMs?: number): void {
    frameHideTimer = setTimeout(() => {
      if (frameEl) {
        frameEl.style.transition = 'opacity 400ms ease-out';
        frameEl.style.opacity = '0';
      }
      frameHideTimer = null;
    }, delayMs || 0);
  }

  // ========================================================================
  // SVG Cursor (same pointer as mcp-dev-browser — Figma-style with shadow)
  // ========================================================================
  function ensureCursor(): void {
    if (cursorInitialized) return;
    cursorInitialized = true;
    try {
      const svgNS = 'http://www.w3.org/2000/svg';
      cursorEl = document.createElementNS(svgNS, 'svg');
      cursorEl.setAttribute('width', '16');
      cursorEl.setAttribute('height', '16');
      cursorEl.setAttribute('viewBox', '0 0 16 16');
      cursorEl.setAttribute('fill', 'none');
      cursorEl.setAttribute('data-opendevs-visual', 'true');
      cursorEl.setAttribute('aria-hidden', 'true');
      cursorEl.style.position = 'fixed';
      cursorEl.style.pointerEvents = 'none';
      cursorEl.style.zIndex = '2147483646';
      cursorEl.style.transform = 'translate(-50%, -50%)';
      cursorEl.style.left = '-1000px';
      cursorEl.style.top = '-1000px';
      cursorEl.style.transition = 'opacity 150ms ease';

      const gClip = document.createElementNS(svgNS, 'g');
      gClip.setAttribute('clip-path', 'url(#clip0_hive_vis)');
      const gFilter = document.createElementNS(svgNS, 'g');
      gFilter.setAttribute('filter', 'url(#filter0_hive_vis)');

      const path = document.createElementNS(svgNS, 'path');
      path.setAttribute('d', 'M1.68066 2.14282C1.5253 1.49746 2.16954 0.975576 2.75195 1.21118L2.86816 1.26782L3.11035 1.41333L12.958 7.27954L13.2031 7.42505C13.8128 7.78856 13.682 8.70779 12.9951 8.88696L12.7197 8.95825L8.28223 10.1155L6.16895 13.9592L6.02148 14.2288C5.66933 14.869 4.71301 14.741 4.54199 14.0305L4.4707 13.7317L1.74707 2.41724L1.68066 2.14282Z');
      path.setAttribute('fill', 'black');
      path.setAttribute('stroke', 'white');
      gFilter.appendChild(path);
      gClip.appendChild(gFilter);

      const defs = document.createElementNS(svgNS, 'defs');
      const filter = document.createElementNS(svgNS, 'filter');
      filter.setAttribute('id', 'filter0_hive_vis');
      filter.setAttribute('x', '-1.51');
      filter.setAttribute('y', '-1.35');
      filter.setAttribute('width', '18.27');
      filter.setAttribute('height', '19.83');
      filter.setAttribute('filterUnits', 'userSpaceOnUse');
      filter.setAttribute('color-interpolation-filters', 'sRGB');

      const feFlood = document.createElementNS(svgNS, 'feFlood');
      feFlood.setAttribute('flood-opacity', '0');
      feFlood.setAttribute('result', 'BackgroundImageFix');
      filter.appendChild(feFlood);
      const feCM = document.createElementNS(svgNS, 'feColorMatrix');
      feCM.setAttribute('in', 'SourceAlpha');
      feCM.setAttribute('type', 'matrix');
      feCM.setAttribute('values', '0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0');
      feCM.setAttribute('result', 'hardAlpha');
      filter.appendChild(feCM);
      const feOff = document.createElementNS(svgNS, 'feOffset');
      feOff.setAttribute('dy', '0.667');
      filter.appendChild(feOff);
      const feBlur = document.createElementNS(svgNS, 'feGaussianBlur');
      feBlur.setAttribute('stdDeviation', '1.333');
      filter.appendChild(feBlur);
      const feComp = document.createElementNS(svgNS, 'feComposite');
      feComp.setAttribute('in2', 'hardAlpha');
      feComp.setAttribute('operator', 'out');
      filter.appendChild(feComp);
      const feCM2 = document.createElementNS(svgNS, 'feColorMatrix');
      feCM2.setAttribute('type', 'matrix');
      feCM2.setAttribute('values', '0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.5 0');
      filter.appendChild(feCM2);
      const feB1 = document.createElementNS(svgNS, 'feBlend');
      feB1.setAttribute('mode', 'normal');
      feB1.setAttribute('in2', 'BackgroundImageFix');
      feB1.setAttribute('result', 'effect1');
      filter.appendChild(feB1);
      const feB2 = document.createElementNS(svgNS, 'feBlend');
      feB2.setAttribute('mode', 'normal');
      feB2.setAttribute('in', 'SourceGraphic');
      feB2.setAttribute('in2', 'effect1');
      feB2.setAttribute('result', 'shape');
      filter.appendChild(feB2);
      defs.appendChild(filter);

      const clipPath = document.createElementNS(svgNS, 'clipPath');
      clipPath.setAttribute('id', 'clip0_hive_vis');
      const rect = document.createElementNS(svgNS, 'rect');
      rect.setAttribute('width', '16');
      rect.setAttribute('height', '16');
      rect.setAttribute('fill', 'white');
      clipPath.appendChild(rect);
      defs.appendChild(clipPath);

      cursorEl.appendChild(defs);
      cursorEl.appendChild(gClip);
      document.documentElement.appendChild(cursorEl);
    } catch (_e) { /* swallow */ }
  }

  // ========================================================================
  // Cursor Movement
  // ========================================================================
  function moveCursorToViewport(x: number, y: number): number {
    ensureCursor();
    const targetX = Math.round(x + OFFSET_X);
    const targetY = Math.round(y + OFFSET_Y);
    const fromX = lastX == null ? targetX : lastX;
    const fromY = lastY == null ? targetY : lastY;
    const dx = targetX - fromX;
    const dy = targetY - fromY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const duration = Math.max(MIN_MS, Math.min(MAX_MS, Math.round(distance / PX_PER_MS)));

    if (cursorEl) {
      cursorEl.style.transition = 'left ' + duration + 'ms ' + EASING + ', top ' + duration + 'ms ' + EASING + ', opacity 150ms ease';
      cursorEl.style.left = targetX + 'px';
      cursorEl.style.top = targetY + 'px';
    }
    lastX = targetX;
    lastY = targetY;
    return duration;
  }

  function moveCursorToElement(el: Element): number {
    if (!el || !el.getBoundingClientRect) return 0;
    let rect = el.getBoundingClientRect();
    // Scroll into view if needed
    const inView = rect.top >= 0 && rect.left >= 0
      && rect.bottom <= window.innerHeight
      && rect.right <= window.innerWidth;
    if (!inView) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
    rect = el.getBoundingClientRect();
    const cx = Math.round(rect.left + rect.width / 2);
    const cy = Math.round(rect.top + rect.height / 2);
    return moveCursorToViewport(cx, cy);
  }

  // ========================================================================
  // Ripple Effect
  // ========================================================================
  function rippleAt(x: number, y: number): void {
    try {
      // Primary ring — fast, bright, immediate feedback
      const ring1 = document.createElement('div');
      ring1.setAttribute('data-opendevs-visual', 'true');
      ring1.style.position = 'fixed';
      ring1.style.left = x + 'px';
      ring1.style.top = y + 'px';
      ring1.style.width = '28px';
      ring1.style.height = '28px';
      ring1.style.borderRadius = '50%';
      ring1.style.border = '2px solid #3a96dd';
      ring1.style.boxShadow = '0 0 8px 2px rgba(58, 150, 221, 0.4)';
      ring1.style.pointerEvents = 'none';
      ring1.style.zIndex = '2147483647';
      ring1.style.transform = 'translate(-50%, -50%) scale(0.7)';
      ring1.style.opacity = '1';
      // Custom iOS-style curve for energetic expansion
      ring1.style.transition = 'transform 220ms cubic-bezier(0.32, 0.72, 0, 1), opacity 260ms ease-out';
      document.documentElement.appendChild(ring1);

      requestAnimationFrame(() => {
        ring1.style.transform = 'translate(-50%, -50%) scale(1.5)';
        ring1.style.opacity = '0';
        setTimeout(() => { try { ring1.remove(); } catch (_e) { /* swallow */ } }, 300);
      });

      // Secondary ring — staggered, wider, softer (shockwave echo)
      setTimeout(() => {
        const ring2 = document.createElement('div');
        ring2.setAttribute('data-opendevs-visual', 'true');
        ring2.style.position = 'fixed';
        ring2.style.left = x + 'px';
        ring2.style.top = y + 'px';
        ring2.style.width = '28px';
        ring2.style.height = '28px';
        ring2.style.borderRadius = '50%';
        ring2.style.border = '1.5px solid rgba(58, 150, 221, 0.45)';
        ring2.style.pointerEvents = 'none';
        ring2.style.zIndex = '2147483647';
        ring2.style.transform = 'translate(-50%, -50%) scale(0.85)';
        ring2.style.opacity = '0.7';
        ring2.style.transition = 'transform 320ms cubic-bezier(0.32, 0.72, 0, 1), opacity 350ms ease-out';
        document.documentElement.appendChild(ring2);

        requestAnimationFrame(() => {
          ring2.style.transform = 'translate(-50%, -50%) scale(2.2)';
          ring2.style.opacity = '0';
          setTimeout(() => { try { ring2.remove(); } catch (_e) { /* swallow */ } }, 400);
        });
      }, 80);
    } catch (_e) { /* swallow */ }
  }

  // ========================================================================
  // Cursor Pinning (for typing — follows element if it moves)
  // ========================================================================
  function pinCursorToElement(el: Element): void {
    ensureCursor();
    unpinCursor();
    pinnedEl = el;
    try {
      const rect = el.getBoundingClientRect();
      const cx = Math.round(rect.left + rect.width / 2);
      const cy = Math.round(rect.top + rect.height / 2);
      if (cursorEl) {
        cursorEl.style.left = (cx + OFFSET_X) + 'px';
        cursorEl.style.top = (cy + OFFSET_Y) + 'px';
      }
    } catch (_e) { /* swallow */ }

    const update = (): void => {
      if (!pinnedEl || !pinnedEl.getBoundingClientRect) { pinRAF = null; return; }
      try {
        const r = pinnedEl.getBoundingClientRect();
        const cx = Math.round(r.left + r.width / 2);
        const cy = Math.round(r.top + r.height / 2);
        if (cursorEl) {
          cursorEl.style.left = (cx + OFFSET_X) + 'px';
          cursorEl.style.top = (cy + OFFSET_Y) + 'px';
        }
        pinRAF = requestAnimationFrame(update);
      } catch (_e) {
        // Element was removed from DOM during SPA re-render — stop the loop
        pinRAF = null;
        pinnedEl = null;
      }
    };
    pinRAF = requestAnimationFrame(update);
  }

  function unpinCursor(): void {
    if (pinRAF) { cancelAnimationFrame(pinRAF); pinRAF = null; }
    pinnedEl = null;
  }

  function hideCursor(): void {
    unpinCursor();
    if (cursorEl) { cursorEl.style.left = '-1000px'; cursorEl.style.top = '-1000px'; cursorEl.style.opacity = '1'; }
    lastX = null;
    lastY = null;
  }

  // Graceful fade-out: cursor stays visible for dwellMs, then fades + resets
  function fadeCursor(dwellMs?: number): void {
    unpinCursor();
    const ms = dwellMs || 1000;
    setTimeout(() => {
      if (cursorEl) {
        cursorEl.style.transition = 'opacity 250ms ease-out';
        cursorEl.style.opacity = '0';
        setTimeout(() => {
          if (cursorEl) {
            cursorEl.style.left = '-1000px';
            cursorEl.style.top = '-1000px';
            cursorEl.style.opacity = '1';
            cursorEl.style.transition = 'opacity 150ms ease';
          }
          lastX = null;
          lastY = null;
        }, 280);
      }
    }, ms);
  }

  // ========================================================================
  // Screenshot Flash Effect — frame in -> blue tint flash -> frame out
  // ========================================================================
  function screenshotFlash(rect?: { x: number; y: number; width: number; height: number } | null): void {
    try {
      // Show capture frame — wraps region if rect provided, full viewport otherwise
      showFrame(rect || null);

      // --- Phase 1: White camera-shutter pop (asymmetric: fast in, fast out) ---
      const flash = document.createElement('div');
      flash.setAttribute('data-opendevs-visual', 'true');
      flash.style.position = 'fixed';
      flash.style.pointerEvents = 'none';
      flash.style.zIndex = '2147483647';
      flash.style.background = 'white';
      flash.style.opacity = '0.45';
      if (rect) {
        flash.style.left = rect.x + 'px';
        flash.style.top = rect.y + 'px';
        flash.style.width = rect.width + 'px';
        flash.style.height = rect.height + 'px';
      } else {
        flash.style.left = '0'; flash.style.top = '0';
        flash.style.width = '100vw'; flash.style.height = '100vh';
      }
      document.documentElement.appendChild(flash);

      // White pop fades after 50ms — brief enough to feel like a camera shutter
      setTimeout(() => {
        flash.style.transition = 'opacity 120ms ease-out';
        flash.style.opacity = '0';
        setTimeout(() => { try { flash.remove(); } catch (_e) { /* swallow */ } }, 140);

        // --- Phase 2: Blue tint holds, then fades (slow release) ---
        const tint = document.createElement('div');
        tint.setAttribute('data-opendevs-visual', 'true');
        tint.style.position = 'fixed';
        tint.style.pointerEvents = 'none';
        tint.style.zIndex = '2147483647';
        tint.style.background = 'rgba(58, 150, 221, 0.10)';
        tint.style.opacity = '1';
        tint.style.transition = 'opacity 600ms ease-out';
        if (rect) {
          tint.style.left = rect.x + 'px';
          tint.style.top = rect.y + 'px';
          tint.style.width = rect.width + 'px';
          tint.style.height = rect.height + 'px';
          tint.style.borderRadius = '3px';
        } else {
          tint.style.left = '0'; tint.style.top = '0';
          tint.style.width = '100vw'; tint.style.height = '100vh';
        }
        document.documentElement.appendChild(tint);

        // Hold blue tint 350ms so it registers, then fade
        setTimeout(() => {
          tint.style.opacity = '0';
          setTimeout(() => { try { tint.remove(); } catch (_e) { /* swallow */ } }, 650);
        }, 350);
      }, 50);

      // Frame hides after full sequence: 50ms pop + 350ms hold + 600ms fade
      hideFrame(1050);
    } catch (_e) { /* swallow */ }
  }

  // ========================================================================
  // Element Highlight Effect (for snapshot — subtle blue outline pulse)
  // ========================================================================
  function highlightElement(el: Element): void {
    if (!el || !el.getBoundingClientRect) return;
    try {
      const rect = el.getBoundingClientRect();
      const box = document.createElement('div');
      box.setAttribute('data-opendevs-visual', 'true');
      box.style.position = 'fixed';
      box.style.left = rect.left + 'px';
      box.style.top = rect.top + 'px';
      box.style.width = rect.width + 'px';
      box.style.height = rect.height + 'px';
      box.style.border = '2px solid #3a96dd';
      box.style.borderRadius = '3px';
      box.style.background = 'rgba(58, 150, 221, 0.08)';
      box.style.pointerEvents = 'none';
      box.style.zIndex = '2147483646';
      box.style.opacity = '1';
      box.style.transition = 'opacity 400ms ease-out';
      document.documentElement.appendChild(box);

      setTimeout(() => {
        box.style.opacity = '0';
        setTimeout(() => { try { box.remove(); } catch (_e) { /* swallow */ } }, 450);
      }, 300);
    } catch (_e) { /* swallow */ }
  }

  // ========================================================================
  // Page Scan Effect — "AI scanning frame"
  //
  // Two-pass converging scan: slow recon + fast blaze, both landing together.
  // GPU-accelerated: bands use transform, tints use clip-path.
  // ========================================================================
  function scanPage(): void {
    try {
      showFrame();

      const EASE = 'cubic-bezier(0.25, 0.1, 0.25, 1)';
      const BLUE = '58,150,221';

      const P1_MS = 3000;
      const P2_MS = 1100;
      const P2_DELAY = P1_MS - P2_MS;

      // Helper: start a transition reliably by separating initial state from transition.
      const startTransition = (el: HTMLElement, transitions: string, endProps: Record<string, string>): void => {
        document.documentElement.appendChild(el);
        void el.offsetHeight; // force browser to compute the "from" state
        el.style.transition = transitions;
        for (const k in endProps) { (el.style as any)[k] = endProps[k]; }
      };

      // ---- Pass 1: slow recon scan line ----
      const tint1 = document.createElement('div');
      tint1.setAttribute('data-opendevs-visual', 'true');
      tint1.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;'
        + 'pointer-events:none;z-index:2147483645;opacity:1;'
        + 'background:linear-gradient(180deg,'
        + 'rgba(' + BLUE + ',0.18) 0%,rgba(' + BLUE + ',0.12) 40%,'
        + 'rgba(' + BLUE + ',0.06) 75%,transparent 100%);'
        + 'clip-path:inset(0 0 100% 0);';

      const band1 = document.createElement('div');
      band1.setAttribute('data-opendevs-visual', 'true');
      band1.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100px;'
        + 'pointer-events:none;z-index:2147483647;will-change:transform,opacity;'
        + 'background:linear-gradient(180deg,'
        + 'transparent 0%,'
        + 'rgba(' + BLUE + ',0.04) 20%,'
        + 'rgba(' + BLUE + ',0.12) 45%,'
        + 'rgba(' + BLUE + ',0.30) 70%,'
        + 'rgba(' + BLUE + ',0.55) 88%,'
        + 'rgba(' + BLUE + ',0.70) 96%,'
        + 'rgba(' + BLUE + ',0.40) 100%);'
        + 'box-shadow:0 4px 16px 2px rgba(' + BLUE + ',0.40),'
        + '0 2px 40px 6px rgba(' + BLUE + ',0.15);'
        + 'transform:translateY(-100px);opacity:1;';

      document.documentElement.appendChild(tint1);

      startTransition(band1,
        'transform ' + P1_MS + 'ms ' + EASE + ',opacity 400ms ease-out ' + (P1_MS - 400) + 'ms',
        { transform: 'translateY(100vh)', opacity: '0' });

      tint1.style.transition = 'clip-path ' + P1_MS + 'ms ' + EASE;
      tint1.style.clipPath = 'inset(0 0 0% 0)';

      setTimeout(() => { try { band1.remove(); } catch (_e) { /* swallow */ } }, P1_MS + 100);
      setTimeout(() => {
        tint1.style.transition = 'opacity 800ms ease-out';
        tint1.style.opacity = '0';
        setTimeout(() => { try { tint1.remove(); } catch (_e) { /* swallow */ } }, 850);
      }, P1_MS + 800);

      // ---- Pass 2: fast blaze scan line (converges with P1) ----
      setTimeout(() => {
        try {
          const tint2 = document.createElement('div');
          tint2.setAttribute('data-opendevs-visual', 'true');
          tint2.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;'
            + 'pointer-events:none;z-index:2147483645;opacity:1;'
            + 'background:linear-gradient(180deg,'
            + 'rgba(' + BLUE + ',0.12) 0%,rgba(' + BLUE + ',0.08) 40%,'
            + 'rgba(' + BLUE + ',0.04) 75%,transparent 100%);'
            + 'clip-path:inset(0 0 100% 0);';

          const fo2 = Math.min(400, Math.round(P2_MS * 0.15));
          const band2 = document.createElement('div');
          band2.setAttribute('data-opendevs-visual', 'true');
          band2.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:80px;'
            + 'pointer-events:none;z-index:2147483647;will-change:transform,opacity;'
            + 'background:linear-gradient(180deg,'
            + 'transparent 0%,'
            + 'rgba(' + BLUE + ',0.06) 20%,'
            + 'rgba(' + BLUE + ',0.20) 50%,'
            + 'rgba(' + BLUE + ',0.50) 78%,'
            + 'rgba(' + BLUE + ',0.80) 93%,'
            + 'rgba(' + BLUE + ',0.50) 100%);'
            + 'box-shadow:0 3px 14px 2px rgba(' + BLUE + ',0.50),'
            + '0 2px 36px 5px rgba(' + BLUE + ',0.20);'
            + 'transform:translateY(-80px);opacity:1;';

          document.documentElement.appendChild(tint2);

          startTransition(band2,
            'transform ' + P2_MS + 'ms ' + EASE + ',opacity ' + fo2 + 'ms ease-out ' + (P2_MS - fo2) + 'ms',
            { transform: 'translateY(100vh)', opacity: '0' });

          tint2.style.transition = 'clip-path ' + P2_MS + 'ms ' + EASE;
          tint2.style.clipPath = 'inset(0 0 0% 0)';

          setTimeout(() => { try { band2.remove(); } catch (_e) { /* swallow */ } }, P2_MS + 100);
          setTimeout(() => {
            tint2.style.transition = 'opacity 800ms ease-out';
            tint2.style.opacity = '0';
            setTimeout(() => { try { tint2.remove(); } catch (_e) { /* swallow */ } }, 850);
          }, P2_MS + 600);
        } catch (_e) { console.error('[opendevs] scanPage P2:', _e); }
      }, P2_DELAY);

      hideFrame(P1_MS + 1400);
    } catch (_e) { console.error('[opendevs] scanPage:', _e); }
  }

  // ========================================================================
  // Active Glow — breathing edge vignette while AI operates the browser
  // ========================================================================
  function showActiveGlow(): void {
    try {
      // Inject breathing keyframe once — shadow expands/contracts + subtle scale
      if (!activeGlowStyleEl) {
        activeGlowStyleEl = document.createElement('style');
        activeGlowStyleEl.setAttribute('data-opendevs-visual', 'true');
        activeGlowStyleEl.textContent =
          '@keyframes hiveBreathe{'
          + '0%,100%{transform:scale(1);box-shadow:inset 0 0 80px 20px rgba(58,150,221,0.35),inset 0 0 25px 8px rgba(58,150,221,0.40)}'
          + '50%{transform:scale(1.04);box-shadow:inset 0 0 130px 40px rgba(58,150,221,0.45),inset 0 0 50px 18px rgba(58,150,221,0.50)}'
          + '}';
        document.head.appendChild(activeGlowStyleEl);
      }

      if (!activeGlowEl || !activeGlowEl.parentNode) {
        activeGlowEl = document.createElement('div');
        activeGlowEl.setAttribute('data-opendevs-visual', 'true');
        activeGlowEl.style.position = 'fixed';
        activeGlowEl.style.left = '0';
        activeGlowEl.style.top = '0';
        activeGlowEl.style.width = '100vw';
        activeGlowEl.style.height = '100vh';
        activeGlowEl.style.pointerEvents = 'none';
        activeGlowEl.style.zIndex = '2147483644';
        activeGlowEl.style.willChange = 'transform, opacity';
        activeGlowEl.style.transformOrigin = 'center center';
        activeGlowEl.style.transform = 'scale(1)';
        // Static shadow matches 0% keyframe — visible during fade-in before animation starts
        activeGlowEl.style.boxShadow = 'inset 0 0 80px 20px rgba(58, 150, 221, 0.35), inset 0 0 25px 8px rgba(58, 150, 221, 0.40)';
        activeGlowEl.style.opacity = '0';
        document.documentElement.appendChild(activeGlowEl);
      }

      // Fade in via opacity, then start breathing (transform + box-shadow)
      activeGlowEl.style.animation = 'none';
      activeGlowEl.style.transition = 'opacity 250ms ease-out';
      requestAnimationFrame(() => {
        if (!activeGlowEl) return;
        activeGlowEl.style.opacity = '1';
        // Start breathing after fade-in settles
        setTimeout(() => {
          if (!activeGlowEl) return;
          activeGlowEl.style.transition = 'none';
          activeGlowEl.style.animation = 'hiveBreathe 3.5s ease-in-out infinite';
        }, 280);
      });
    } catch (_e) { /* swallow */ }
  }

  function hideActiveGlow(): void {
    if (!activeGlowEl) return;
    try {
      // Keep animation running during fade-out — avoids transform/shadow snap
      activeGlowEl.style.transition = 'opacity 350ms ease-out';
      requestAnimationFrame(() => {
        if (!activeGlowEl) return;
        activeGlowEl.style.opacity = '0';
        // Stop animation after fully faded — invisible so no snap visible
        setTimeout(() => {
          if (activeGlowEl) activeGlowEl.style.animation = 'none';
        }, 400);
      });
    } catch (_e) { /* swallow */ }
  }

  // ========================================================================
  // Key Flash Effect (highlight focused element when a key is pressed)
  // ========================================================================
  function keyFlash(): void {
    try {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) return;
      highlightElement(el);
    } catch (_e) { /* swallow */ }
  }

  // ========================================================================
  // Public API
  // ========================================================================
  (window as any).__opendevsVisuals = {
    moveCursorToViewport,
    moveCursorToElement,
    rippleAt,
    pinCursorToElement,
    unpinCursor,
    hideCursor,
    fadeCursor,
    ensureCursor,
    screenshotFlash,
    highlightElement,
    scanPage,
    keyFlash,
    showFrame,
    hideFrame,
    showActiveGlow,
    hideActiveGlow,
  };
}
