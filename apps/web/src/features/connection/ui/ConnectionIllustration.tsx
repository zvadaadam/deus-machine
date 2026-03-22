/**
 * Warm SVG illustration — laptop and phone connected by a tangled cord.
 * Used on ServerOfflinePage and PairGatePage for friendly empty states.
 */

import { cn } from "@/shared/lib/utils";

interface ConnectionIllustrationProps {
  className?: string;
}

export function ConnectionIllustration({ className }: ConnectionIllustrationProps) {
  return (
    <svg
      viewBox="0 0 320 140"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("w-[280px]", className)}
      aria-hidden="true"
    >
      {/* Phone (left) */}
      <g>
        {/* Phone body */}
        <rect
          x="40"
          y="20"
          width="60"
          height="100"
          rx="12"
          className="fill-bg-elevated stroke-border-subtle"
          strokeWidth="1.5"
        />
        {/* Phone screen */}
        <rect x="47" y="32" width="46" height="72" rx="4" className="fill-bg-surface" />
        {/* Chat bubbles on phone screen */}
        <rect x="51" y="38" width="28" height="8" rx="4" className="fill-border-subtle" />
        <rect x="59" y="50" width="30" height="8" rx="4" className="fill-border-subtle" />
        <rect x="51" y="62" width="24" height="8" rx="4" className="fill-border-subtle" />
        {/* Phone bottom bar */}
        <rect x="57" y="110" width="26" height="4" rx="2" className="fill-border-subtle" />
      </g>

      {/* Tangled cord (center) — the warm accent element */}
      <path
        d="M100 70 C120 70, 115 45, 135 50 C155 55, 140 80, 160 75 C180 70, 175 55, 195 60 C210 64, 205 75, 220 70"
        className="stroke-accent-gold"
        strokeWidth="2.5"
        strokeLinecap="round"
        fill="none"
        opacity="0.85"
      />
      {/* Small loop in the cord */}
      <path
        d="M145 52 C150 40, 162 42, 158 55"
        className="stroke-accent-gold"
        strokeWidth="2.5"
        strokeLinecap="round"
        fill="none"
        opacity="0.85"
      />

      {/* Laptop (right) */}
      <g>
        {/* Laptop screen */}
        <rect
          x="220"
          y="28"
          width="72"
          height="52"
          rx="6"
          className="fill-bg-elevated stroke-border-subtle"
          strokeWidth="1.5"
        />
        {/* Laptop screen inner */}
        <rect x="226" y="34" width="60" height="40" rx="2" className="fill-bg-surface" />
        {/* Cursor on laptop screen */}
        <path
          d="M252 48 L252 62 L258 58 L264 64"
          className="stroke-text-muted"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
        {/* Laptop base */}
        <path
          d="M212 80 L300 80 L296 88 C295 90 293 92 290 92 L222 92 C219 92 217 90 216 88 Z"
          className="fill-bg-elevated stroke-border-subtle"
          strokeWidth="1.5"
        />
        {/* Laptop hinge line */}
        <line
          x1="224"
          y1="80"
          x2="288"
          y2="80"
          className="stroke-border-subtle"
          strokeWidth="0.5"
        />
      </g>
    </svg>
  );
}
