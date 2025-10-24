import { cn } from "@/shared/lib/utils";

interface PulseRadiateIconProps {
  isActive?: boolean;
  className?: string;
}

export function PulseRadiateIcon({ isActive = false, className }: PulseRadiateIconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={cn("inline-block", className)}
      style={{ width: "1em", height: "1em" }}
    >
      <defs>
        <style>{`
          @keyframes radiate {
            0% { r: 2; opacity: 1; }
            100% { r: 7; opacity: 0; }
          }
          .pulse-ring {
            stroke: currentColor;
            stroke-width: 0.5;
            fill: none;
            animation: ${isActive ? "radiate 1.2s ease-out infinite" : "none"};
          }
        `}</style>
      </defs>
      <circle cx="8" cy="8" r="2" fill="currentColor" />
      {isActive && (
        <>
          <circle className="pulse-ring" cx="8" cy="8" r="2" />
          <circle className="pulse-ring" cx="8" cy="8" r="2" style={{ animationDelay: "0.4s" }} />
          <circle className="pulse-ring" cx="8" cy="8" r="2" style={{ animationDelay: "0.8s" }} />
        </>
      )}
    </svg>
  );
}
