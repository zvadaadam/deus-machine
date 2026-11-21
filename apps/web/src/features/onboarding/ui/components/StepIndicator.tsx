import { cn } from "@/shared/lib/utils";

interface StepIndicatorProps {
  currentStep: number;
  totalSteps: number;
}

export function StepIndicator({ currentStep, totalSteps }: StepIndicatorProps) {
  return (
    <div className="flex items-center gap-2">
      {Array.from({ length: totalSteps }, (_, i) => (
        <div
          key={i}
          className={cn(
            "tempo-moderate ease-move h-1.5 rounded-full transition-[width,background-color]",
            i === currentStep
              ? "bg-onboarding-foreground w-6"
              : i < currentStep
                ? "bg-onboarding-foreground/50 w-1.5"
                : "bg-onboarding-foreground/20 w-1.5"
          )}
        />
      ))}
    </div>
  );
}
