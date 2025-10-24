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
      <style>{`
        @keyframes radiate {
          0% { r: 4; opacity: 1; }
          30% { r: 12; opacity: 0.6; }
          60% { r: 22; opacity: 0.3; }
          100% { r: 30; opacity: 0; }
        }
        .pulse-ring-active {
          stroke: currentColor;
          stroke-width: 1.5;
          fill: none;
          animation: radiate 1.5s cubic-bezier(0.4, 0, 0.2, 1) infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .pulse-ring-active {
            animation: none;
          }
        }
      `}</style>
      <circle cx="16" cy="16" r="4" fill="currentColor" />
      {isActive && (
        <>
          <circle className="pulse-ring-active" cx="16" cy="16" r="4" />
          <circle className="pulse-ring-active" cx="16" cy="16" r="4" style={{ animationDelay: "0.4s" }} />
          <circle className="pulse-ring-active" cx="16" cy="16" r="4" style={{ animationDelay: "0.8s" }} />
        </>
      )}
    </svg>
  );
}
