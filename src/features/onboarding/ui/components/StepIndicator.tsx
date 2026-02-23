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
            "h-1.5 rounded-full transition-[width,background-color] duration-300 motion-reduce:transition-none",
            i === currentStep
              ? "w-6 bg-white"
              : i < currentStep
                ? "w-1.5 bg-white/50"
                : "w-1.5 bg-white/20"
          )}
          style={{ transitionTimingFunction: "cubic-bezier(.215, .61, .355, 1)" }}
        />
      ))}
    </div>
  );
}
