import { useState, useCallback, useEffect, useRef } from "react";
import { useSettings } from "@/features/settings";
import { native } from "@/platform";
import { cn } from "@/shared/lib/utils";
import { track } from "@/platform/analytics";
import { StepIndicator } from "./components/StepIndicator";
import { WelcomeStep } from "./steps/WelcomeStep";
import { GitHubSetupStep } from "./steps/GitHubSetupStep";
import { AIToolsCheckStep } from "./steps/AIToolsCheckStep";
import { DeusStep } from "./steps/DeusStep";
import { ProjectSelectionStep } from "./steps/ProjectSelectionStep";
import type { OnboardingStep } from "../types";

const TOTAL_STEPS = 5;
const STEP_NAMES = ["welcome", "github", "ai-tools", "project-selection", "finish"];

/** Full-screen onboarding view — dark, grain-textured, CLI-inspired. */
export function OnboardingOverlay() {
  const { refetch } = useSettings();

  const [currentStep, setCurrentStep] = useState<OnboardingStep>(0);
  const [animClass, setAnimClass] = useState("");
  const [animating, setAnimating] = useState(false);
  const [exiting, setExiting] = useState(false);
  const onboardingStartRef = useRef(0);

  useEffect(() => {
    onboardingStartRef.current = Date.now();
    native.window.enterOnboarding().catch(console.error);
  }, []);

  const trackedRef = useRef(false);
  useEffect(() => {
    if (trackedRef.current) return;
    trackedRef.current = true;
    track("onboarding_started");
  }, []);

  useEffect(() => {
    if (!exiting) return;
    const timer = setTimeout(() => void refetch(), 600);
    return () => clearTimeout(timer);
  }, [exiting, refetch]);

  const goForward = useCallback(() => {
    if (animating) return;
    setAnimating(true);
    setAnimClass(
      "animate-[onboarding-step-exit-forward_160ms_cubic-bezier(.215,.61,.355,1)_forwards]"
    );
    setTimeout(() => {
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
    native.window.exitOnboarding().catch(console.error);
    setExiting(true);
  }, [exiting]);

  return (
    <div
      className={cn(
        "fixed inset-0 flex items-center justify-center",
        exiting && "opacity-0 transition-opacity duration-500 ease-out"
      )}
      style={{ zIndex: 9999 }}
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
          "relative z-10 w-full max-w-[560px] px-10",
          currentStep === 0 ? "h-[80vh]" : "",
          !exiting && "animate-[onboarding-card-enter_420ms_cubic-bezier(.215,.61,.355,1)_forwards]"
        )}
        style={{ opacity: exiting ? undefined : 0 }}
      >
        {currentStep !== 0 && (
          <div className="flex justify-center pb-6">
            <StepIndicator currentStep={currentStep} totalSteps={TOTAL_STEPS} />
          </div>
        )}

        <div className={cn("w-full", currentStep === 0 ? "h-full" : "", animClass)}>
          {currentStep === 0 && <WelcomeStep onNext={goForward} />}
          {currentStep === 1 && <GitHubSetupStep onNext={goForward} onBack={goBack} />}
          {currentStep === 2 && <AIToolsCheckStep onNext={goForward} onBack={goBack} />}
          {currentStep === 3 && <ProjectSelectionStep onBack={goBack} onNext={goForward} />}
          {currentStep === 4 && <DeusStep onBack={goBack} onComplete={handleComplete} />}
        </div>
      </div>
    </div>
  );
}
