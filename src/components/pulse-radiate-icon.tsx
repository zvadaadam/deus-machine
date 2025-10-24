import { cn } from "@/shared/lib/utils";

interface PulseRadiateIconProps {
  isActive?: boolean;
  className?: string;
}

export function PulseRadiateIcon({ isActive = false, className }: PulseRadiateIconProps) {
  const uniqueId = `radiate-${Math.random().toString(36).substr(2, 9)}`;

  return (
    <svg
      viewBox="0 0 16 16"
      className={cn("inline-block", className)}
      style={{ width: "1em", height: "1em" }}
    >
      <style>{`
        @keyframes ${uniqueId} {
          0% {
            transform: scale(1);
            opacity: 0.8;
          }
          100% {
            transform: scale(4);
            opacity: 0;
          }
        }
        .${uniqueId}-ring {
          stroke: currentColor;
          stroke-width: 1;
          fill: none;
          transform-origin: 8px 8px;
          transform-box: fill-box;
          animation: ${isActive ? `${uniqueId} 1.2s cubic-bezier(.215, .61, .355, 1) infinite` : "none"};
        }
      `}</style>
      <circle cx="8" cy="8" r="1.5" fill="currentColor" />
      {isActive && (
        <>
          <circle className={`${uniqueId}-ring`} cx="8" cy="8" r="1.5" />
          <circle className={`${uniqueId}-ring`} cx="8" cy="8" r="1.5" style={{ animationDelay: "0.4s" }} />
          <circle className={`${uniqueId}-ring`} cx="8" cy="8" r="1.5" style={{ animationDelay: "0.8s" }} />
        </>
      )}
    </svg>
  );
}
