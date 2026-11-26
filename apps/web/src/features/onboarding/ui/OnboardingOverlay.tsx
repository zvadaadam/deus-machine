import { useState, useEffect, useRef } from "react";
import { m } from "framer-motion";
import { native } from "@/platform";
import { cn } from "@/shared/lib/utils";
import { tempo } from "@/shared/lib/tempo";
import { track } from "@/platform/analytics";
import { StepIndicator } from "./components/StepIndicator";
import { WelcomeStep } from "./steps/WelcomeStep";
import { CloudSignInStep } from "./steps/CloudSignInStep";
import { GitHubSetupStep } from "./steps/GitHubSetupStep";
import { AIToolsCheckStep } from "./steps/AIToolsCheckStep";
import { DeusStep } from "./steps/DeusStep";
import { ProjectSelectionStep } from "./steps/ProjectSelectionStep";
import type { OnboardingStep } from "../types";

const TOTAL_STEPS = 6;
// Order must match the step switch below — analytics reads it by index, so a
// step inserted without updating this silently mislabels every later step.
const STEP_NAMES = [
  "welcome",
  "cloud-sign-in",
  "github",
  "ai-tools",
  "project-selection",
  "finish",
];

/** Full-screen onboarding view — dark, grain-textured, CLI-inspired. */
export function OnboardingOverlay() {
  const [currentStep, setCurrentStep] = useState<OnboardingStep>(0);
  const [direction, setDirection] = useState<1 | -1>(1);
  const [phase, setPhase] = useState<"enter" | "exit">();
  const onboardingStartRef = useRef(0);

  useEffect(() => {
    onboardingStartRef.current = Date.now();
    native.window.enterOnboarding().catch(console.error);
    return () => void native.window.exitOnboarding().catch(console.error);
  }, []);

  const trackedRef = useRef(false);
  useEffect(() => {
    if (trackedRef.current) return;
    trackedRef.current = true;
    track("onboarding_started");
  }, []);

  function changeStep(by: 1 | -1) {
    if (phase === "exit") return;
    setDirection(by);
    setPhase("exit");
  }

  function finishStepExit(event: React.AnimationEvent) {
    if (event.target !== event.currentTarget || event.animationName !== "onboarding-step-exit")
      return;
    const next = Math.max(0, Math.min(currentStep + direction, TOTAL_STEPS - 1)) as OnboardingStep;
    setCurrentStep(next);
    if (direction === 1)
      track("onboarding_step_viewed", { step: next, step_name: STEP_NAMES[next] });
    setPhase("enter");
  }

  const goForward = () => changeStep(1);
  const goBack = () => changeStep(-1);

  function handleComplete() {
    track("onboarding_completed", { duration_ms: Date.now() - onboardingStartRef.current });
  }

  return (
    <m.div
      className="fixed inset-0 flex items-center justify-center"
      style={{ zIndex: 9999 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: tempo.slow.exit }}
      transition={tempo.slow}
    >
      {/* Background: black → dark gray gradient (bottom up) */}
      <div
        className="absolute inset-0"
        style={{
          background: "linear-gradient(to top, oklch(0.14 0.005 264), oklch(0.04 0.002 264) 70%)",
        }}
      />

      {/* Film grain overlay */}
      <div className="onboarding-grain absolute inset-0 opacity-[0.035]" />

      {/* Content */}
      <div
        className={cn(
          "relative z-10 w-full max-w-[560px] animate-[onboarding-card-enter_var(--tempo-slow)_var(--tempo-ease)] px-10",
          currentStep === 0 && "h-[80vh]"
        )}
      >
        {currentStep !== 0 && (
          <div className="flex justify-center pb-6">
            <StepIndicator currentStep={currentStep} totalSteps={TOTAL_STEPS} />
          </div>
        )}

        <div
          onAnimationEnd={finishStepExit}
          className={cn(
            "w-full",
            currentStep === 0 && "h-full",
            direction === -1 && "[--step-x:-60px]",
            phase === "exit" &&
              "animate-[onboarding-step-exit_var(--tempo-slow-exit)_var(--tempo-ease)_forwards]",
            phase === "enter" &&
              "animate-[onboarding-step-enter_var(--tempo-slow)_var(--tempo-ease)]"
          )}
        >
          {currentStep === 0 && <WelcomeStep onNext={goForward} />}
          {currentStep === 1 && <CloudSignInStep onNext={goForward} onBack={goBack} />}
          {currentStep === 2 && <GitHubSetupStep onNext={goForward} onBack={goBack} />}
          {currentStep === 3 && <AIToolsCheckStep onNext={goForward} onBack={goBack} />}
          {currentStep === 4 && <ProjectSelectionStep onBack={goBack} onNext={goForward} />}
          {currentStep === 5 && <DeusStep onBack={goBack} onComplete={handleComplete} />}
        </div>
      </div>
    </m.div>
  );
}
