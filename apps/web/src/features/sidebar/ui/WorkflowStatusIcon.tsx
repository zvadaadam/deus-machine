import React from "react";
import { match } from "ts-pattern";
import type { WorkspaceStatus } from "@shared/enums";

interface WorkflowStatusIconProps {
  status: WorkspaceStatus;
  size?: number;
  className?: string;
}

/** Partial arc circle used by in-progress and in-review statuses. */
function ProgressCircle({
  cx,
  cy,
  r,
  c,
  fraction,
  color,
}: {
  cx: number;
  cy: number;
  r: number;
  c: number;
  fraction: number;
  color: string;
}) {
  return (
    <>
      <circle cx={cx} cy={cy} r={r} stroke={color} strokeWidth={1.5} opacity={0.3} />
      <circle
        cx={cx}
        cy={cy}
        r={r}
        stroke={color}
        strokeWidth={1.5}
        strokeDasharray={`${c * fraction} ${c}`}
        strokeDashoffset={c * 0.25}
        strokeLinecap="round"
        transform={`rotate(-90 ${cx} ${cy})`}
      />
    </>
  );
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
        .with("in-progress", () => (
          <ProgressCircle
            cx={half}
            cy={half}
            r={r}
            c={circumference}
            fraction={0.5}
            color="var(--status-in-progress)"
          />
        ))
        .with("in-review", () => (
          <ProgressCircle
            cx={half}
            cy={half}
            r={r}
            c={circumference}
            fraction={0.75}
            color="var(--status-in-review)"
          />
        ))
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
              y1={half - r * 0.5}
              x2={half + r * 0.5}
              y2={half + r * 0.5}
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
