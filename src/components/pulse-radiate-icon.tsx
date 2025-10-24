import { cn } from "@/shared/lib/utils";

interface PulseRadiateIconProps {
  isActive?: boolean;
  className?: string;
}

export function PulseRadiateIcon({ isActive = false, className }: PulseRadiateIconProps) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={cn("inline-block", className)}
      style={{ width: "1em", height: "1em", overflow: "visible" }}
    >
      <defs>
        <style>{`
          @keyframes radiate {
            0% { r: 3; opacity: 1; }
            100% { r: 14; opacity: 0; }
          }
          .pulse-ring {
            stroke: currentColor;
            stroke-width: 1;
            fill: none;
            animation: ${isActive ? "radiate 1.2s ease-out infinite" : "none"};
          }
        `}</style>
      </defs>
      <circle cx="16" cy="16" r="3" fill="currentColor" />
      {isActive && (
        <>
          <circle className="pulse-ring" cx="16" cy="16" r="3" />
          <circle className="pulse-ring" cx="16" cy="16" r="3" style={{ animationDelay: "0.4s" }} />
          <circle className="pulse-ring" cx="16" cy="16" r="3" style={{ animationDelay: "0.8s" }} />
        </>
      )}
    </svg>
  );
}
