import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useRef, useState, useCallback } from "react";
import { VISUAL_EFFECTS_SETUP } from "./visual-effects";

// ============================================================================
// Shared hook: inject __deusVisuals into the window on mount
// ============================================================================
function useVisualEffects() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!(window as any).__deusVisuals) {
      eval(VISUAL_EFFECTS_SETUP);
    }
    setReady(!!(window as any).__deusVisuals);
    return () => {
      // Clean up cursor SVG + any leftover visual elements
      document.querySelectorAll("[data-deus-visual]").forEach((el) => el.remove());
      delete (window as any).__deusVisuals;
    };
  }, []);

  return { ready, v: (window as any).__deusVisuals as HiveVisuals | null };
}

type HiveVisuals = {
  moveCursorToViewport: (x: number, y: number) => number;
  moveCursorToElement: (el: Element) => number;
  rippleAt: (x: number, y: number) => void;
  pinCursorToElement: (el: Element) => void;
  unpinCursor: () => void;
  hideCursor: () => void;
  fadeCursor: (dwellMs?: number) => void;
  ensureCursor: () => void;
  screenshotFlash: (rect: { x: number; y: number; width: number; height: number } | null) => void;
  highlightElement: (el: Element) => void;
  scanPage: () => void;
  keyFlash: () => void;
  showFrame: (rect?: { x: number; y: number; width: number; height: number } | null) => void;
  hideFrame: (delayMs?: number) => void;
  showActiveGlow: () => void;
  hideActiveGlow: () => void;
};

// ============================================================================
// Reusable test button
// ============================================================================
function TestButton({
  children,
  onClick,
  variant = "default",
}: {
  children: React.ReactNode;
  onClick: () => void;
  variant?: "default" | "accent";
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg border px-3 py-2 text-base transition-colors duration-200 ${
        variant === "accent"
          ? "border-primary/30 bg-primary/10 text-primary hover:bg-primary/20"
          : "border-border bg-muted/30 text-foreground hover:bg-muted/60"
      }`}
    >
      {children}
    </button>
  );
}

// ============================================================================
// Status badge
// ============================================================================
function StatusBadge({ ready }: { ready: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-xs ${
        ready ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${ready ? "bg-emerald-400" : "bg-red-400"}`} />
      {ready ? "__deusVisuals injected" : "Not injected"}
    </span>
  );
}

// ============================================================================
// Section wrapper
// ============================================================================
function Section({
  number,
  title,
  description,
  children,
}: {
  number: number;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-border/40 rounded-xl border bg-black/20 p-5">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-primary font-mono text-xs font-semibold">{number}.</span>
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      <p className="text-muted-foreground mb-4 text-sm">{description}</p>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

// ============================================================================
// 1. Capture Frame (shared by scan + screenshot)
// ============================================================================
function CaptureFrame() {
  const { ready, v } = useVisualEffects();
  const sectionRef = useRef<HTMLDivElement>(null);

  return (
    <div ref={sectionRef}>
      <Section
        number={1}
        title="Capture Frame"
        description="3px blue border overlay with sharp edges. Full viewport: 4px inset. Region: 6px padding around rect. Shared by screenshot + page scan."
      >
        <StatusBadge ready={ready} />
        <TestButton
          onClick={() => {
            if (!v) return;
            v.showFrame();
            v.hideFrame(2000);
          }}
          variant="accent"
        >
          Full Frame (2s)
        </TestButton>
        <TestButton
          onClick={() => {
            if (!v || !sectionRef.current) return;
            const rect = sectionRef.current.getBoundingClientRect();
            v.showFrame({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
            v.hideFrame(2000);
          }}
        >
          Region Frame (this section)
        </TestButton>
        <TestButton onClick={() => v?.hideFrame(0)}>Hide Frame Now</TestButton>
      </Section>
    </div>
  );
}

// ============================================================================
// 2. Cursor Move + Ripple
// ============================================================================
function CursorMoveRipple() {
  const { ready, v } = useVisualEffects();
  const targetA = useRef<HTMLButtonElement>(null);
  const targetB = useRef<HTMLButtonElement>(null);
  const targetC = useRef<HTMLSpanElement>(null);

  const handleClick = useCallback(
    (el: Element | null) => {
      if (!v || !el) return;
      const dur = v.moveCursorToElement(el);
      setTimeout(() => {
        const rect = el.getBoundingClientRect();
        v.rippleAt(Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2));
      }, dur + 20);
    },
    [v]
  );

  return (
    <Section
      number={2}
      title="Cursor Move + Ripple (BrowserClick)"
      description="Cursor travels from current position to element center, then 28px blue ripple ring with glow expands. Distance-based timing: 1.5px/ms, clamped 440–1000ms."
    >
      <StatusBadge ready={ready} />
      <TestButton onClick={() => handleClick(targetA.current)}>
        <span ref={targetA as any}>Click Target A</span>
      </TestButton>
      <TestButton onClick={() => handleClick(targetB.current)}>
        <span ref={targetB as any}>Click Target B</span>
      </TestButton>
      <span
        ref={targetC}
        onClick={() => handleClick(targetC.current)}
        className="border-border/40 text-muted-foreground cursor-pointer rounded-lg border border-dashed px-4 py-2.5 text-base"
      >
        Target C (far right)
      </span>
    </Section>
  );
}

// ============================================================================
// 3. Cursor Dwell + Fade
// ============================================================================
function CursorDwellFade() {
  const { ready, v } = useVisualEffects();

  const testFade = useCallback(
    (ms: number) => {
      if (!v) return;
      v.moveCursorToViewport(200, 300);
      setTimeout(() => v.fadeCursor(ms), 500);
    },
    [v]
  );

  const testHide = useCallback(() => {
    if (!v) return;
    v.moveCursorToViewport(200, 300);
    setTimeout(() => v.hideCursor(), 500);
  }, [v]);

  return (
    <Section
      number={3}
      title="Cursor Dwell + Fade"
      description="After click: cursor dwells 1s (default) then fades out over 250ms. Compare with instant hide (used after typing)."
    >
      <StatusBadge ready={ready} />
      <TestButton onClick={() => testFade(1000)}>Fade (1s default)</TestButton>
      <TestButton onClick={() => testFade(600)}>Fade (600ms)</TestButton>
      <TestButton onClick={() => testFade(1500)}>Fade (1.5s)</TestButton>
      <TestButton onClick={testHide} variant="accent">
        Instant Hide
      </TestButton>
    </Section>
  );
}

// ============================================================================
// 4. Cursor Pin (for typing)
// ============================================================================
function CursorPin() {
  const { ready, v } = useVisualEffects();
  const inputRef = useRef<HTMLInputElement>(null);

  const testPin = useCallback(() => {
    if (!v || !inputRef.current) return;
    const dur = v.moveCursorToElement(inputRef.current);
    setTimeout(() => v.pinCursorToElement(inputRef.current!), dur + 20);
  }, [v]);

  const testUnpin = useCallback(() => {
    if (!v) return;
    v.hideCursor();
  }, [v]);

  return (
    <Section
      number={4}
      title="Cursor Pin (BrowserType)"
      description="Cursor moves to input and pins (follows via rAF). Stays pinned until unpinned."
    >
      <StatusBadge ready={ready} />
      <input
        ref={inputRef}
        placeholder="Type target input"
        className="border-border bg-muted/30 focus:border-primary rounded-lg border px-3 py-2 text-base outline-none"
      />
      <TestButton onClick={testPin} variant="accent">
        Pin to Input
      </TestButton>
      <TestButton onClick={testUnpin}>Unpin + Hide</TestButton>
    </Section>
  );
}

// ============================================================================
// 5. Ripple Only
// ============================================================================
function RippleOnly() {
  const { ready, v } = useVisualEffects();

  return (
    <Section
      number={5}
      title="Ripple Only"
      description="Double-ring shockwave. Primary: 28px, 0.7→1.5, 220ms. Secondary echo follows 80ms later, 0.85→2.2, 320ms. iOS-style bezier."
    >
      <StatusBadge ready={ready} />
      <TestButton
        onClick={() => {
          if (!v) return;
          v.rippleAt(window.innerWidth / 2, window.innerHeight / 2);
        }}
      >
        Ripple at Viewport Center
      </TestButton>
      <div
        onClick={(e) => {
          if (!v) return;
          v.rippleAt(e.clientX, e.clientY);
        }}
        className="border-border/40 text-muted-foreground cursor-crosshair rounded-lg border border-dashed px-6 py-3 text-sm"
      >
        Click anywhere in this box for ripple
      </div>
    </Section>
  );
}

// ============================================================================
// 6. Screenshot Flash (frame + blue tint)
// ============================================================================
function ScreenshotFlash() {
  const { ready, v } = useVisualEffects();
  const sectionRef = useRef<HTMLDivElement>(null);

  return (
    <div ref={sectionRef}>
      <Section
        number={6}
        title="Screenshot Flash (BrowserScreenshot)"
        description="Camera shutter: white pop (50ms) → blue tint hold (350ms) → fade (600ms). Asymmetric timing per Emil Kowalski."
      >
        <StatusBadge ready={ready} />
        <TestButton onClick={() => v?.screenshotFlash(null)} variant="accent">
          Full Page Flash
        </TestButton>
        <TestButton
          onClick={() => {
            if (!v || !sectionRef.current) return;
            const rect = sectionRef.current.getBoundingClientRect();
            v.screenshotFlash({
              x: rect.left,
              y: rect.top,
              width: rect.width,
              height: rect.height,
            });
          }}
        >
          Region Flash (this section)
        </TestButton>
      </Section>
    </div>
  );
}

// ============================================================================
// 7. Element Highlight
// ============================================================================
function ElementHighlight() {
  const { ready, v } = useVisualEffects();
  const buttonRef = useRef<HTMLButtonElement>(null);

  return (
    <Section
      number={7}
      title="Element Highlight (BrowserPressKey)"
      description="Blue outline + fill pulse on focused element. Stays 300ms, fades over 400ms."
    >
      <StatusBadge ready={ready} />
      <input
        placeholder="Focus me first"
        className="border-border bg-muted/30 focus:border-primary rounded-lg border px-3 py-2 text-base outline-none"
      />
      <TestButton onClick={() => v?.keyFlash()}>Key Flash (focused)</TestButton>
      <button
        ref={buttonRef}
        onClick={() => v?.highlightElement(buttonRef.current!)}
        className="border-primary/30 bg-primary/10 text-primary hover:bg-primary/20 rounded-lg border px-3 py-2 text-base transition-colors duration-200"
      >
        Highlight This Button
      </button>
    </Section>
  );
}

// ============================================================================
// 8. Page Scan (frame + sweep band)
// ============================================================================
function PageScan() {
  const { ready, v } = useVisualEffects();

  return (
    <Section
      number={8}
      title="Page Scan (BrowserSnapshot)"
      description="Two-pass converging scanner lines (~4.4s). Slow recon (100px, 3s) + fast blaze (80px, 1.1s) with bright leading edges and box-shadow glow. Both converge at the bottom at 3s. Trailing tints grow behind each band via clip-path, then fade."
    >
      <StatusBadge ready={ready} />
      <TestButton onClick={() => v?.scanPage()} variant="accent">
        Scan Page
      </TestButton>
      <TestButton
        onClick={() => {
          if (!v) return;
          v.scanPage();
          setTimeout(() => v.scanPage(), 300);
          setTimeout(() => v.scanPage(), 600);
        }}
      >
        Scan x3 (rapid)
      </TestButton>
    </Section>
  );
}

// ============================================================================
// 9. Active Glow (ambient edge vignette during tool execution)
// ============================================================================
function ActiveGlow() {
  const { ready, v } = useVisualEffects();
  const [active, setActive] = useState(false);

  return (
    <Section
      number={9}
      title="Active Glow (Tool Execution)"
      description="Breathing edge vignette — shadow physically grows (blur 80→130, spread 15→35) + scale(1→1.04) over 3.5s cycle. Keeps breathing during fade-out for smooth exit."
    >
      <StatusBadge ready={ready} />
      <TestButton
        onClick={() => {
          if (!v) return;
          if (active) {
            v.hideActiveGlow();
            setActive(false);
          } else {
            v.showActiveGlow();
            setActive(true);
          }
        }}
        variant="accent"
      >
        {active ? "Hide Glow" : "Show Glow"}
      </TestButton>
      <TestButton
        onClick={() => {
          if (!v) return;
          v.showActiveGlow();
          setActive(true);
          setTimeout(() => {
            v.hideActiveGlow();
            setActive(false);
          }, 5000);
        }}
      >
        Glow for 5s (simulated tool call)
      </TestButton>
      <TestButton
        onClick={() => {
          if (!v) return;
          // Simulate rapid tool calls: glow on → scan → glow off
          v.showActiveGlow();
          setActive(true);
          setTimeout(() => v.scanPage(), 300);
          setTimeout(() => {
            v.hideActiveGlow();
            setActive(false);
          }, 6000);
        }}
      >
        Glow + Scan (combined)
      </TestButton>
    </Section>
  );
}

// ============================================================================
// 10. Full Click Sequence (end-to-end)
// ============================================================================
function FullClickSequence() {
  const { ready, v } = useVisualEffects();
  const [log, setLog] = useState("");
  const targetA = useRef<HTMLButtonElement>(null);
  const targetB = useRef<HTMLButtonElement>(null);
  const targetC = useRef<HTMLSpanElement>(null);

  const runSequence = useCallback(
    (el: Element | null) => {
      if (!v || !el) return;
      setLog("Moving cursor...");
      const dur = v.moveCursorToElement(el);
      setTimeout(() => {
        const rect = el.getBoundingClientRect();
        v.rippleAt(Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2));
        setLog(`Ripple fired (travel=${dur}ms). Dwelling 1s then fade...`);
        v.fadeCursor();
        setTimeout(() => setLog("Sequence complete."), 1000 + 280);
      }, dur + 20);
    },
    [v]
  );

  return (
    <Section
      number={10}
      title="Full Click Sequence (end-to-end)"
      description="Simulates BrowserClick: move cursor → ripple → dwell 1s → fade. Click different targets to see travel distance."
    >
      <StatusBadge ready={ready} />
      <TestButton onClick={() => runSequence(targetA.current)}>
        <span ref={targetA as any}>Sequence A</span>
      </TestButton>
      <TestButton onClick={() => runSequence(targetB.current)}>
        <span ref={targetB as any}>Sequence B</span>
      </TestButton>
      <span
        ref={targetC}
        onClick={() => runSequence(targetC.current)}
        className="border-border/40 text-muted-foreground cursor-pointer rounded-lg border border-dashed px-4 py-2.5 text-base"
      >
        Sequence C
      </span>
      {log && <span className="font-mono text-xs text-emerald-400">{log}</span>}
    </Section>
  );
}

// ============================================================================
// Composed Demo (all effects on one page)
// ============================================================================
function VisualEffectsDemo() {
  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <div>
        <h2 className="text-lg font-semibold">Deus Visual Effects</h2>
        <p className="text-muted-foreground text-base">
          Interactive test for all browser automation visual effects. These are injected into the
          WKWebView during AI actions.
        </p>
      </div>
      <CaptureFrame />
      <CursorMoveRipple />
      <CursorDwellFade />
      <CursorPin />
      <RippleOnly />
      <ScreenshotFlash />
      <ElementHighlight />
      <PageScan />
      <ActiveGlow />
      <FullClickSequence />
    </div>
  );
}

// ============================================================================
// Storybook meta
// ============================================================================
const meta: Meta = {
  title: "Browser/VisualEffects",
  parameters: {
    layout: "padded",
  },
};
export default meta;

/** All 9 visual effects in one interactive page */
export const AllEffects: StoryObj = {
  render: () => <VisualEffectsDemo />,
};

/** Capture frame — shared rounded border for scan + screenshot */
export const Frame: StoryObj = {
  render: () => (
    <div className="flex max-w-3xl flex-col gap-5">
      <CaptureFrame />
      <ScreenshotFlash />
      <PageScan />
    </div>
  ),
};

/** Cursor movement — distance-based timing (1.5px/ms, 440-1000ms range) */
export const CursorMovement: StoryObj = {
  render: () => (
    <div className="flex max-w-3xl flex-col gap-5">
      <CursorMoveRipple />
      <CursorDwellFade />
      <CursorPin />
    </div>
  ),
};

/** Visual feedback effects — ripple, flash, highlight, scan, glow */
export const Feedback: StoryObj = {
  render: () => (
    <div className="flex max-w-3xl flex-col gap-5">
      <RippleOnly />
      <ScreenshotFlash />
      <ElementHighlight />
      <PageScan />
      <ActiveGlow />
    </div>
  ),
};

/** Full end-to-end click sequence */
export const ClickSequence: StoryObj = {
  render: () => (
    <div className="max-w-3xl">
      <FullClickSequence />
    </div>
  ),
};
