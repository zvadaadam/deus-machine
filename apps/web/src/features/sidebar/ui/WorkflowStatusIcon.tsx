import React from "react";
import { match } from "ts-pattern";
import type { WorkspaceStatus } from "@shared/enums";

interface WorkflowStatusIconProps {
  status: WorkspaceStatus;
  size?: number;
  className?: string;
}

/**
 * Linear-style workflow status icons.
 *
 * Backlog     → dashed circle (gray)
 * In Progress → half-filled circle (amber)
 * In Review   → 3/4 filled circle (purple)
 * Done        → filled circle + checkmark (green)
 * Canceled    → circle + diagonal line (gray)
 */
export const WorkflowStatusIcon = React.memo(function WorkflowStatusIcon({
  status,
  size = 14,
  className,
}: WorkflowStatusIconProps) {
  const half = size / 2;
  const r = half - 1.5; // radius with stroke inset
  const circumference = 2 * Math.PI * r;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      fill="none"
      className={className}
      aria-label={status}
    >
      {match(status)
        .with("backlog", () => (
          <circle
            cx={half}
            cy={half}
            r={r}
            stroke="var(--muted-foreground)"
            strokeWidth={1.5}
            strokeDasharray="2 2.5"
            opacity={0.6}
          />
        ))
        .with("in-progress", () => {
          // Half-filled circle: full outline + 50% arc fill
          const halfArc = circumference * 0.5;
          return (
            <>
              <circle
                cx={half}
                cy={half}
                r={r}
                stroke="var(--status-in-progress)"
                strokeWidth={1.5}
                opacity={0.3}
              />
              <circle
                cx={half}
                cy={half}
                r={r}
                stroke="var(--status-in-progress)"
                strokeWidth={1.5}
                strokeDasharray={`${halfArc} ${circumference}`}
                strokeDashoffset={circumference * 0.25}
                strokeLinecap="round"
                transform={`rotate(-90 ${half} ${half})`}
              />
            </>
          );
        })
        .with("in-review", () => {
          // 3/4 filled circle
          const threeQuarterArc = circumference * 0.75;
          return (
            <>
              <circle
                cx={half}
                cy={half}
                r={r}
                stroke="var(--status-in-review)"
                strokeWidth={1.5}
                opacity={0.3}
              />
              <circle
                cx={half}
                cy={half}
                r={r}
                stroke="var(--status-in-review)"
                strokeWidth={1.5}
                strokeDasharray={`${threeQuarterArc} ${circumference}`}
                strokeDashoffset={circumference * 0.25}
                strokeLinecap="round"
                transform={`rotate(-90 ${half} ${half})`}
              />
            </>
          );
        })
        .with("done", () => {
          // Filled circle + checkmark
          const checkScale = size / 14;
          return (
            <>
              <circle cx={half} cy={half} r={r} fill="var(--status-done)" />
              <path
                d={`M${4 * checkScale} ${7 * checkScale} L${6.5 * checkScale} ${9.5 * checkScale} L${10 * checkScale} ${4.5 * checkScale}`}
                stroke="var(--background)"
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              />
            </>
          );
        })
        .with("canceled", () => (
          // Circle + diagonal line
          <>
            <circle
              cx={half}
              cy={half}
              r={r}
              stroke="var(--muted-foreground)"
              strokeWidth={1.5}
              opacity={0.4}
            />
            <line
              x1={half - r * 0.5}
              y1={half}
              x2={half + r * 0.5}
              y2={half}
              stroke="var(--muted-foreground)"
              strokeWidth={1.5}
              strokeLinecap="round"
              opacity={0.6}
            />
          </>
        ))
        .exhaustive()}
    </svg>
  );
});
