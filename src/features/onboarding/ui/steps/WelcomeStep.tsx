interface WelcomeStepProps {
  onNext: () => void;
}

/**
 * Welcome step — rendered inside the onboarding card.
 * "Welcome to" subtitle + "hivenet" in Geist Pixel font + tagline + pill CTA.
 * The Agent Dots animation has already played and filled white before this appears.
 */
export function WelcomeStep({ onNext }: WelcomeStepProps) {
  return (
    <div className="flex w-full flex-col items-center gap-6 py-6">
      {/* Logo / Title */}
      <div className="flex flex-col items-center gap-2">
        <p className="text-xs font-medium tracking-[0.25em] text-white/25 uppercase">
          Welcome to
        </p>
        <h1
          className="text-[42px] tracking-wide text-white"
          style={{ fontFamily: "var(--font-pixel)" }}
        >
          hivenet
        </h1>
      </div>

      {/* Tagline */}
      <p className="max-w-[280px] text-center text-[14px] leading-relaxed text-white/40">
        Manage multiple AI coding agents in parallel. Ship faster with your dev team of AIs.
      </p>

      {/* Get Started button — pill shape, subtle glow */}
      <button
        onClick={onNext}
        className="mt-2 rounded-full bg-white px-10 py-3 text-sm font-semibold text-black/90 transition-[transform,background-color] duration-200 hover:scale-[1.03] hover:bg-white/95 active:scale-[0.98]"
        style={{
          boxShadow: "0 0 30px -4px oklch(0.65 0.15 264 / 0.3), 0 2px 12px oklch(0 0 0 / 0.2)",
        }}
      >
        Get Started
      </button>
    </div>
  );
}
