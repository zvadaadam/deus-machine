import { useState, useCallback, useRef } from "react";
import { cn } from "@/shared/lib/utils";
import { EASE_OUT_QUART_CSS } from "@/shared/lib/animation";

interface WelcomeStepProps {
  onNext: () => void;
}

type Phase = "idle" | "fade-content" | "center" | "swap" | "exit";

export function WelcomeStep({ onNext }: WelcomeStepProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [titleOffset, setTitleOffset] = useState(0);
  const titleRef = useRef<HTMLDivElement>(null);

  const handleRun = useCallback(() => {
    if (phase !== "idle") return;

    // Skip animation choreography for users who prefer reduced motion
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      onNext();
      return;
    }

    // Measure exact offset to viewport center
    if (titleRef.current) {
      const rect = titleRef.current.getBoundingClientRect();
      const titleCenter = rect.top + rect.height / 2;
      const viewportCenter = window.innerHeight / 2;
      setTitleOffset(viewportCenter - titleCenter);
    }

    // Phase 1: fade out button
    setPhase("fade-content");

    // Phase 2: title floats to true center
    setTimeout(() => setPhase("center"), 500);

    // Phase 3: swap text Deus → Devs (no glitch, clean)
    setTimeout(() => setPhase("swap"), 1400);

    // Phase 4: slide left + fade, then advance
    setTimeout(() => setPhase("exit"), 2200);
    setTimeout(() => onNext(), 2800);
  }, [phase, onNext]);

  const isAnimating = phase !== "idle";
  const showDevs = phase === "swap" || phase === "exit";

  return (
    <div className="relative flex h-full w-full flex-col items-center justify-center">
      {/* Brand title */}
      <div
        ref={titleRef}
        className={cn("text-center select-none", isAnimating && "z-10")}
        style={{
          transition:
            phase === "exit"
              ? `transform 600ms ${EASE_OUT_QUART_CSS}, opacity 500ms ${EASE_OUT_QUART_CSS}`
              : `transform 700ms ${EASE_OUT_QUART_CSS}`,
          ...(phase === "center" || phase === "swap"
            ? { transform: `translateY(${titleOffset}px)` }
            : phase === "exit"
              ? { transform: `translateX(-40%) translateY(${titleOffset}px)`, opacity: 0 }
              : {}),
        }}
      >
        <h1 className="text-[86px] leading-[0.88] font-extrabold tracking-tighter text-white">
          <span className="relative inline-block">
            {/* Deus — fades out */}
            <span
              style={{
                transition: `opacity 400ms ${EASE_OUT_QUART_CSS}`,
                opacity: showDevs ? 0 : 1,
              }}
            >
              Deus
            </span>
            {/* Devs — fades in, positioned on top */}
            <span
              className="absolute inset-0"
              style={{
                transition: `opacity 400ms ${EASE_OUT_QUART_CSS}`,
                opacity: showDevs ? 1 : 0,
              }}
            >
              Devs
            </span>
          </span>
        </h1>
        <span className="text-[86px] leading-[0.88] font-extrabold tracking-tighter text-white/20">
          machine.
        </span>
      </div>

      {/* CTA */}
      <div
        className="mt-8"
        style={{
          transition: `opacity 400ms ${EASE_OUT_QUART_CSS}, transform 400ms ${EASE_OUT_QUART_CSS}`,
          ...(isAnimating ? { opacity: 0, transform: "translateY(12px)" } : {}),
        }}
      >
        <button
          onClick={handleRun}
          className="rounded-full bg-white px-10 py-3.5 text-sm font-semibold text-black/90 hover:scale-[1.04] hover:opacity-95 active:scale-[0.97]"
          style={{
            boxShadow: "0 0 30px -4px oklch(0.65 0.15 264 / 0.3), 0 2px 12px oklch(0 0 0 / 0.2)",
            transition: isAnimating
              ? `opacity 400ms ${EASE_OUT_QUART_CSS}, transform 400ms ${EASE_OUT_QUART_CSS}`
              : `scale 250ms ${EASE_OUT_QUART_CSS}, opacity 200ms ${EASE_OUT_QUART_CSS}`,
          }}
        >
          Run Deus
        </button>
      </div>
    </div>
  );
}
