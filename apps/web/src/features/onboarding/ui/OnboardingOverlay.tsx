import { useState, useCallback, useEffect, useRef } from "react";
import { useSettings } from "@/features/settings";
import { native, capabilities } from "@/platform";
import { cn } from "@/shared/lib/utils";
import { track } from "@/platform/analytics";
import { useOnboardingAudio } from "../hooks/useOnboardingAudio";
import { StepIndicator } from "./components/StepIndicator";
import { AgentDotsAnimation } from "./AgentDotsAnimation";
import { WelcomeStep } from "./steps/WelcomeStep";
import { GitHubSetupStep } from "./steps/GitHubSetupStep";
import { AIToolsCheckStep } from "./steps/AIToolsCheckStep";
import { OpenDevsStep } from "./steps/OpenDevsStep";
import { ProjectSelectionStep } from "./steps/ProjectSelectionStep";
import type { OnboardingStep } from "../types";

// ─── Timeline ───────────────────────────────────────────────────────────────
//
// Agent Dots SVG (~10s at 30fps):
//   Phase 1 (0–2s):    Center dot breathes
//   Phase 2 (2–6s):    Rings spawn + vortex spin
//   Phase 3 (6–7s):    "The Pull" — dots converge, center expands
//
// Transition (staggered):
//   The white circle fills the screen by ~6.7s (cover mode). We start fading
//   at 6.5s — the white is growing but hasn't taken over yet. The card
//   enters 350ms later, once the white has dissolved enough to not blind.
//
//   6.0s    6.7s       7.05s       7.4s
//    │       ├─ fade ───────────────┤  (700ms, opacity 1→0)
//    │       │          ├─ card ────┤  (420ms, CSS enter anim)
//    │       │          │           │
//    pull    fade       card in     anim unmounts
//    starts  starts     350ms gap   card fully visible
//
const TIMELINE = {
  MUSIC_START: 450,
  INTRO_COMPLETE: 6700, // Let white expansion show more before fading
  CARD_DELAY: 350, // Gap before card — let white dissolve first
  FADE_DURATION: 700, // Moderate fade while center still expanding
  EXIT_DURATION: 900, // Exit animation before window restore
} as const;

const TOTAL_STEPS = 5;
const OVERLAY_BG = "oklch(0.06 0.005 264 / 0.52)";

// Card surface — no border. Light and shadow define form, not lines.
// Top inset highlight mimics an edge-lit surface (like brushed aluminium
// catching light from above). Two-layer shadow: close contact shadow for
// grounding + large diffuse shadow for atmospheric depth.
const CARD_STYLE = {
  background: "oklch(0.13 0.012 264 / 0.92)",
  backdropFilter: "blur(40px) saturate(1.4)",
  WebkitBackdropFilter: "blur(40px) saturate(1.4)",
  boxShadow: [
    "inset 0 0.5px 0 0 oklch(1 0 0 / 0.06)",
    "0 8px 20px -4px oklch(0 0 0 / 0.25)",
    "0 24px 68px -12px oklch(0 0 0 / 0.5)",
  ].join(", "),
} as const;

// Fixed card height — prevents the card from jumping size between steps.
// Tallest step is ProjectSelection (~header + 320px list + footer).
const CARD_HEIGHT = 560;

/**
 * Onboarding overlay with Agent Dots intro animation.
 *
 * Sequence:
 *   1. Semi-transparent dark overlay fades in over the desktop
 *   2. Agent Dots play on transparent bg (dots float over overlay)
 *   3. Animation fades out during "The Pull" (~7-8s)
 *   4. Card fades in → user navigates steps
 *   5. Complete → exit animation → overlay dissolves → window restores
 *
 * Window architecture (Electron):
 *   - Main window renders everything fullscreen
 *   - Transparent background with vibrancy for macOS
 */
export function OnboardingOverlay() {
  const settingsQuery = useSettings();
  const audio = useOnboardingAudio("/audio/intro-music.mp3");

  const [currentStep, setCurrentStep] = useState<OnboardingStep>(0);
  const [animClass, setAnimClass] = useState("");
  const [animating, setAnimating] = useState(false);
  const [exiting, setExiting] = useState(false);

  const [showAnimation, setShowAnimation] = useState(true);
  const [animationFading, setAnimationFading] = useState(false);
  const [showCard, setShowCard] = useState(false);

  const introCompletedRef = useRef(false);
  const exitHandledRef = useRef(false);
  const onboardingStartRef = useRef(0);

  // Initialize timestamp on first mount (pure — no impure function call during render)
  useEffect(() => {
    if (onboardingStartRef.current === 0) {
      onboardingStartRef.current = Date.now();
    }
  }, []);

  // Idempotent — starts fade, then brings card in after a short delay.
  // The stagger lets the white circle dissolve before the card appears,
  // so the user sees: expanding white → dissolving glow → card emerges.
  const completeIntro = useCallback(() => {
    if (introCompletedRef.current) return;
    introCompletedRef.current = true;

    setAnimationFading(true);
    setTimeout(() => {
      setShowCard(true); // Card enters once white has partly dissolved
    }, TIMELINE.CARD_DELAY);
    setTimeout(() => {
      setShowAnimation(false); // Unmount SVG after fully transparent
    }, TIMELINE.FADE_DURATION);
  }, []);

  // ── Enter/exit onboarding mode (StrictMode-safe) ────────────────────
  // React 18 StrictMode double-mounts: mount → unmount → remount.
  // No ref guard — let enter run every mount. The native code is idempotent
  // (saves frame only once, restores on exit, re-saves on next enter).
  // Sequence in StrictMode: enter → exit → enter → stays entered. ✅
  useEffect(() => {
    if (capabilities.nativeOnboarding) {
      native.window.enterOnboarding().catch((e) => {
        console.error("[Onboarding] enter_onboarding_mode failed:", e);
      });
    } else {
      document.body.style.background = "oklch(0 0 0)";
      document.getElementById("root")!.style.background = "transparent";
    }

    return () => {
      // On real unmount (or StrictMode simulated unmount): restore everything.
      // StrictMode re-mount will call enter again, which is correct.
      audio.stop();
      if (!exitHandledRef.current) {
        if (capabilities.nativeOnboarding) {
          native.window.exitOnboarding().catch((e) => {
            console.error("[Onboarding] exit_onboarding_mode cleanup:", e);
          });
        } else {
          document.body.style.background = "";
          document.getElementById("root")!.style.background = "";
        }
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- audio.stop() in cleanup is intentional; audio ref is stable

  // ── Analytics: track onboarding start (StrictMode-safe) ──────────────
  const onboardingTrackedRef = useRef(false);
  useEffect(() => {
    if (onboardingTrackedRef.current) return;
    onboardingTrackedRef.current = true;
    track("onboarding_started");
  }, []);

  // ── Phase sequencing ──────────────────────────────────────────────────
  useEffect(() => {
    const timers = [
      setTimeout(() => audio.play(), TIMELINE.MUSIC_START),
      setTimeout(() => completeIntro(), TIMELINE.INTRO_COMPLETE),
    ];
    return () => timers.forEach(clearTimeout);
  }, [audio, completeIntro]);

  // ── Exit handler (user completed onboarding) ──────────────────────────
  useEffect(() => {
    if (!exiting || exitHandledRef.current) return;

    const timer = setTimeout(() => {
      if (exitHandledRef.current) return;
      exitHandledRef.current = true;

      if (capabilities.nativeOnboarding) {
        native.window.exitOnboarding().catch((e) => {
          console.error("[Onboarding] exit_onboarding_mode failed:", e);
        });
      } else {
        document.body.style.background = "";
        document.getElementById("root")!.style.background = "";
      }
      settingsQuery.refetch();
    }, TIMELINE.EXIT_DURATION);

    return () => clearTimeout(timer);
  }, [exiting, settingsQuery]);

  // ── Step navigation ───────────────────────────────────────────────────
  const goForward = useCallback(() => {
    if (animating) return;
    setAnimating(true);
    setAnimClass(
      "animate-[onboarding-step-exit-forward_160ms_cubic-bezier(.215,.61,.355,1)_forwards]"
    );
    setTimeout(() => {
      const STEP_NAMES = ["welcome", "github", "ai-tools", "project-selection", "finish"];
      const nextStep = Math.min(currentStep + 1, 4) as OnboardingStep;
      setCurrentStep(nextStep);
      track("onboarding_step_viewed", { step: nextStep, step_name: STEP_NAMES[nextStep] });
      setAnimClass("animate-[onboarding-step-enter-forward_240ms_cubic-bezier(.215,.61,.355,1)]");
      setAnimating(false);
    }, 160);
  }, [animating, currentStep]);

  const goBack = useCallback(() => {
    if (animating) return;
    setAnimating(true);
    setAnimClass(
      "animate-[onboarding-step-exit-back_160ms_cubic-bezier(.215,.61,.355,1)_forwards]"
    );
    setTimeout(() => {
      setCurrentStep((prev) => Math.max(prev - 1, 0) as OnboardingStep);
      setAnimClass("animate-[onboarding-step-enter-back_240ms_cubic-bezier(.215,.61,.355,1)]");
      setAnimating(false);
    }, 160);
  }, [animating]);

  const handleComplete = useCallback(() => {
    if (exiting) return;
    track("onboarding_completed", { duration_ms: Date.now() - onboardingStartRef.current });
    audio.fadeOut();
    setExiting(true);
  }, [audio, exiting]);

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0" style={{ zIndex: 9999 }}>
      {/* Layer 1: Semi-transparent dark overlay with subtle top gradient.
       *  Fades in on mount via CSS animation. Desktop visible behind.
       *  During exit, fades to fully transparent. */}
      <div
        className={cn(
          "absolute inset-0",
          exiting && "animate-[onboarding-exit-scrim_0.9s_cubic-bezier(.215,.61,.355,1)_forwards]"
        )}
        style={{
          background: [
            "radial-gradient(120% 80% at 50% 0%, oklch(1 0 0 / 0.05) 0%, oklch(1 0 0 / 0) 55%)",
            OVERLAY_BG,
          ].join(", "),
          animation: exiting
            ? undefined
            : "onboarding-overlay-fade-in 520ms cubic-bezier(.215,.61,.355,1) forwards",
        }}
      />

      {/* Layer 2: Agent Dots SVG animation.
       *  Fills the entire viewport with cover mode so the final white
       *  expansion reaches all corners (SVG crops the square into the
       *  viewport rectangle, like CSS object-fit: cover).
       *  Fades out over FADE_DURATION when intro completes, then unmounts. */}
      {showAnimation && (
        <div
          className="absolute inset-0"
          style={{
            pointerEvents: "none",
            opacity: animationFading ? 0 : 1,
            transition: `opacity ${TIMELINE.FADE_DURATION}ms cubic-bezier(.215,.61,.355,1)`,
          }}
        >
          <AgentDotsAnimation
            dotColor="#fff"
            backgroundColor="transparent"
            autoPlay
            loop={false}
            cover
            onComplete={completeIntro}
            className="h-full w-full"
          />
        </div>
      )}

      {/* Layer 3: Onboarding card.
       *  Fades in after the animation dissolves.
       *  During exit, dissolves upward with blur (no remount). */}
      {showCard && (
        <div
          className={cn(
            "absolute inset-0 flex items-center justify-center px-4",
            exiting && "pointer-events-none"
          )}
          style={{ zIndex: 1 }}
        >
          <div
            className={cn(
              "relative w-full max-w-[560px]",
              exiting
                ? "animate-[onboarding-exit-card_700ms_cubic-bezier(.215,.61,.355,1)_forwards]"
                : "animate-[onboarding-card-enter_420ms_cubic-bezier(.215,.61,.355,1)_forwards]"
            )}
            style={{ opacity: 0 }}
          >
            {/* Card surface */}
            <div
              className="flex w-full flex-col overflow-hidden rounded-3xl"
              style={{ height: CARD_HEIGHT, maxHeight: "80vh", ...CARD_STYLE }}
            >
              {/* Always render indicator to reserve space — invisible on step 0. */}
              <div
                className={cn(
                  "flex justify-center pt-6 transition-opacity duration-200",
                  currentStep === 0 ? "opacity-0" : "opacity-100"
                )}
              >
                <StepIndicator currentStep={currentStep} totalSteps={TOTAL_STEPS} />
              </div>

              <div
                className={cn(
                  "flex w-full flex-1 items-center justify-center overflow-y-auto px-10 py-8",
                  animClass
                )}
              >
                {currentStep === 0 && <WelcomeStep onNext={goForward} />}
                {currentStep === 1 && <GitHubSetupStep onNext={goForward} onBack={goBack} />}
                {currentStep === 2 && <AIToolsCheckStep onNext={goForward} onBack={goBack} />}
                {currentStep === 3 && <ProjectSelectionStep onBack={goBack} onNext={goForward} />}
                {currentStep === 4 && <OpenDevsStep onBack={goBack} onComplete={handleComplete} />}
              </div>
            </div>

            {/* Bottom ambient gradient — the card "emerges" from the overlay
             *  rather than ending with a hard edge. Elliptical gradient
             *  narrows inward so it feels organic, not rectangular. */}
            <div
              className="pointer-events-none absolute inset-x-12 -bottom-16 h-24"
              style={{
                background:
                  "radial-gradient(ellipse 100% 100% at 50% 0%, oklch(0 0 0 / 0.35) 0%, transparent 70%)",
                filter: "blur(10px)",
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
