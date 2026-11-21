import { useState, useCallback, useRef, useEffect } from "react";
import { cn } from "@/shared/lib/utils";
import { tempo } from "@/shared/lib/tempo";

interface WelcomeStepProps {
  onNext: () => void;
}

type Phase = "idle" | "fade-content" | "center" | "swap" | "exit";

export function WelcomeStep({ onNext }: WelcomeStepProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [titleOffset, setTitleOffset] = useState(0);
  const titleRef = useRef<HTMLDivElement>(null);

  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

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

    setPhase("fade-content");
    const step = tempo.step * 1000;
    timers.current = [
      setTimeout(() => setPhase("center"), 4 * step),
      setTimeout(() => setPhase("swap"), 11 * step),
      setTimeout(() => setPhase("exit"), 22 * step),
      setTimeout(onNext, 25 * step),
    ];
  }, [phase, onNext]);

  const isAnimating = phase !== "idle";
  const showDevs = phase === "swap" || phase === "exit";

  return (
    <div className="relative flex h-full w-full flex-col items-center justify-center">
      {/* Brand title */}
      <div
        ref={titleRef}
        className={cn(
          "text-center transition-[transform,opacity] select-none",
          isAnimating && "z-10",
          phase === "exit" ? "tempo-slow-exit" : "tempo-slow ease-move"
        )}
        style={
          phase === "center" || phase === "swap"
            ? { transform: `translateY(${titleOffset}px)` }
            : phase === "exit"
              ? { transform: `translateX(-40%) translateY(${titleOffset}px)`, opacity: 0 }
              : undefined
        }
      >
        <h1 className="text-onboarding-foreground text-[86px] leading-[0.88] font-extrabold tracking-tighter">
          <span className="relative inline-block">
            {/* Deus — fades out */}
            <span
              className={cn(
                "transition-opacity",
                showDevs ? "tempo-slow-exit opacity-0" : "tempo-slow"
              )}
            >
              Deus
            </span>
            {/* Devs — fades in, positioned on top */}
            <span
              className={cn(
                "absolute inset-0 transition-opacity",
                showDevs ? "tempo-slow" : "tempo-slow-exit opacity-0"
              )}
            >
              Devs
            </span>
          </span>
        </h1>
        <span className="text-onboarding-foreground/20 text-[86px] leading-[0.88] font-extrabold tracking-tighter">
          machine.
        </span>
      </div>

      {/* CTA */}
      <div
        className={cn(
          "tempo-slow-exit mt-8 transition-[opacity,translate]",
          isAnimating && "translate-y-3 opacity-0"
        )}
      >
        <button
          onClick={handleRun}
          className="control-interaction bg-onboarding-foreground text-onboarding-contrast/90 hover:bg-onboarding-foreground/90 active:bg-onboarding-foreground/80 rounded-full px-10 py-3.5 text-sm font-medium hover:opacity-95"
          style={{
            boxShadow: "0 0 30px -4px oklch(0.65 0.15 264 / 0.3), 0 2px 12px oklch(0 0 0 / 0.2)",
          }}
        >
          Run Deus
        </button>
      </div>
    </div>
  );
}
