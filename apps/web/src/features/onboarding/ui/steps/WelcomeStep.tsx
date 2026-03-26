import { useState, useCallback, useRef } from "react";
import { cn } from "@/shared/lib/utils";

interface WelcomeStepProps {
  onNext: () => void;
}

type Phase = "idle" | "fade-content" | "center" | "swap" | "exit";

const MANIFESTO =
  "For a decade, designing and building software products was how I expressed myself. " +
  "A slow but fulfilling journey. " +
  "Then the world changed. " +
  "AI got good enough to build whatever I imagine. " +
  "I got completely addicted. It's never been more fun to build. " +
  "There are amazing tools for managing agents. My favorites Conductor and Cursor. " +
  "But I wanted to do some things differently. " +
  "We have godlike machines now. Why wouldn't I? " +
  "How should a machine that writes software look today? How will it evolve? " +
  "It's funny that one person can even try to answer that. " +
  "So I built this. " +
  "Many agents. Many branches. All at once. " +
  "You describe what you want. The machines figure out how. " +
  "This is not an IDE. This is how I build now. " +
  "Deus machine.";

const EASE_OUT_QUART = "cubic-bezier(0.165, 0.84, 0.44, 1)";

export function WelcomeStep({ onNext }: WelcomeStepProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [titleOffset, setTitleOffset] = useState(0);
  const titleRef = useRef<HTMLDivElement>(null);

  const handleRun = useCallback(() => {
    if (phase !== "idle") return;

    // Measure exact offset to viewport center
    if (titleRef.current) {
      const rect = titleRef.current.getBoundingClientRect();
      const titleCenter = rect.top + rect.height / 2;
      const viewportCenter = window.innerHeight / 2;
      setTitleOffset(viewportCenter - titleCenter);
    }

    // Phase 1: fade out button + manifesto
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
    <div className="relative flex h-full w-full flex-col items-center">
      {/* Brand title */}
      <div
        ref={titleRef}
        className={cn("mt-4 text-center select-none", isAnimating && "z-10")}
        style={{
          transition:
            phase === "exit"
              ? `transform 600ms ${EASE_OUT_QUART}, opacity 500ms ${EASE_OUT_QUART}`
              : `transform 700ms ${EASE_OUT_QUART}`,
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
                transition: `opacity 400ms ${EASE_OUT_QUART}`,
                opacity: showDevs ? 0 : 1,
              }}
            >
              Deus
            </span>
            {/* Devs — fades in, positioned on top */}
            <span
              className="absolute inset-0"
              style={{
                transition: `opacity 400ms ${EASE_OUT_QUART}`,
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

      {/* Scrolling manifesto */}
      <div
        className="relative min-h-0 w-full max-w-[360px] flex-1 overflow-hidden"
        style={{
          maskImage:
            "linear-gradient(to bottom, transparent 0%, black 8%, black 85%, transparent 100%)",
          WebkitMaskImage:
            "linear-gradient(to bottom, transparent 0%, black 8%, black 85%, transparent 100%)",
          transition: `opacity 400ms ${EASE_OUT_QUART}, transform 400ms ${EASE_OUT_QUART}`,
          ...(isAnimating ? { opacity: 0, transform: "translateY(12px)" } : {}),
        }}
      >
        <div style={{ animation: "manifesto-crawl 25s linear infinite" }}>
          {[MANIFESTO, MANIFESTO].map((text, i) => (
            <p key={i} className="pb-4 text-center text-xs leading-5 text-white/20">
              {text}
            </p>
          ))}
        </div>
      </div>

      {/* CTA */}
      <div
        className="shrink-0 pt-4 pb-4"
        style={{
          transition: `opacity 400ms ${EASE_OUT_QUART}, transform 400ms ${EASE_OUT_QUART}`,
          ...(isAnimating ? { opacity: 0, transform: "translateY(12px)" } : {}),
        }}
      >
        <button
          onClick={handleRun}
          className="rounded-full bg-white px-10 py-3.5 text-sm font-semibold text-black/90 hover:scale-[1.04] hover:opacity-95 active:scale-[0.97]"
          style={{
            boxShadow: "0 0 30px -4px oklch(0.65 0.15 264 / 0.3), 0 2px 12px oklch(0 0 0 / 0.2)",
            transition: isAnimating
              ? `opacity 400ms ${EASE_OUT_QUART}, transform 400ms ${EASE_OUT_QUART}`
              : `scale 250ms ${EASE_OUT_QUART}, opacity 200ms ${EASE_OUT_QUART}`,
          }}
        >
          Run Deus
        </button>
      </div>
    </div>
  );
}
