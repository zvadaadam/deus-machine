/**
 * PixelGrid - 3x3 animated pixel grid for agent status indication
 *
 * Each variant represents a different agent processing phase:
 * - thinking: Wave columns (blue) - deliberate reasoning
 * - generating: Random sparkle (green) - creative text generation
 * - toolExecuting: Snake walk (amber) - methodical tool execution
 * - error: Cross pulse (red) - tool execution failed
 * - compacting: Slow sparkle (violet) - context compaction
 *
 * Uses CSS keyframes (global.css) with --pixel-glow custom property for color.
 * Zero-gap grid with box-shadow glow bleeds between cells for ambient effect.
 */

import { cn } from "@/shared/lib/utils";

export type PixelGridVariant = "thinking" | "generating" | "toolExecuting" | "error" | "compacting";

interface PixelGridProps {
  variant: PixelGridVariant;
  size?: number; // Total grid size in px (default 24)
  peakOpacity?: number; // Max cell opacity 0–1 (default 1)
  glowBlur?: number; // Box-shadow blur in px (default 4)
  glowSpread?: number; // Box-shadow spread in px (default 1)
  className?: string;
}

// Per-cell animation config: keyframe name, duration, delay
// null = cell stays off (opacity 0)
type CellAnim = { name: string; dur: string; del: string } | null;

interface VariantConfig {
  color: string; // CSS variable reference for glow color
  cells: CellAnim[];
}

const VARIANTS: Record<PixelGridVariant, VariantConfig> = {
  // Wave columns - cells in same column share delay, creates left-to-right wave
  thinking: {
    color: "var(--primary)",
    cells: [
      { name: "pixel-wave", dur: "1.5s", del: "0s" },
      { name: "pixel-wave", dur: "1.5s", del: "0.2s" },
      { name: "pixel-wave", dur: "1.5s", del: "0.4s" },
      { name: "pixel-wave", dur: "1.5s", del: "0s" },
      { name: "pixel-wave", dur: "1.5s", del: "0.2s" },
      { name: "pixel-wave", dur: "1.5s", del: "0.4s" },
      { name: "pixel-wave", dur: "1.5s", del: "0s" },
      { name: "pixel-wave", dur: "1.5s", del: "0.2s" },
      { name: "pixel-wave", dur: "1.5s", del: "0.4s" },
    ],
  },

  // Random sparkle - varied durations/delays create organic twinkling
  generating: {
    color: "var(--success)",
    cells: [
      { name: "pixel-sparkle", dur: "2s", del: "0.1s" },
      { name: "pixel-sparkle", dur: "3s", del: "1.5s" },
      { name: "pixel-sparkle", dur: "2.5s", del: "0.7s" },
      { name: "pixel-sparkle", dur: "2.2s", del: "1.1s" },
      { name: "pixel-sparkle", dur: "1.8s", del: "0.3s" },
      { name: "pixel-sparkle", dur: "2.7s", del: "1.9s" },
      { name: "pixel-sparkle", dur: "2.1s", del: "0.5s" },
      { name: "pixel-sparkle", dur: "2.9s", del: "1.3s" },
      { name: "pixel-sparkle", dur: "1.6s", del: "0.9s" },
    ],
  },

  // Snake walk - clockwise perimeter path, center stays dim
  // Path: 0→1→2→5→8→7→6→3, delays staggered along the path
  toolExecuting: {
    color: "var(--warning)",
    cells: [
      { name: "pixel-snake", dur: "1.6s", del: "0s" },
      { name: "pixel-snake", dur: "1.6s", del: "0.2s" },
      { name: "pixel-snake", dur: "1.6s", del: "0.4s" },
      { name: "pixel-snake", dur: "1.6s", del: "1.4s" },
      null, // Center cell stays dim
      { name: "pixel-snake", dur: "1.6s", del: "0.6s" },
      { name: "pixel-snake", dur: "1.6s", del: "1.2s" },
      { name: "pixel-snake", dur: "1.6s", del: "1.0s" },
      { name: "pixel-snake", dur: "1.6s", del: "0.8s" },
    ],
  },

  // Cross pulse - only edge-centers + center animate (plus/cross pattern)
  // Corners stay dim for visual contrast
  error: {
    color: "var(--destructive)",
    cells: [
      null, // corner
      { name: "pixel-pulse", dur: "2s", del: "0s" },
      null, // corner
      { name: "pixel-pulse", dur: "2s", del: "0s" },
      { name: "pixel-pulse", dur: "2s", del: "0s" },
      { name: "pixel-pulse", dur: "2s", del: "0s" },
      null, // corner
      { name: "pixel-pulse", dur: "2s", del: "0s" },
      null, // corner
    ],
  },

  // Slow ambient sparkle - like generating but slower and more subtle
  compacting: {
    color: "var(--status-compacting)",
    cells: [
      { name: "pixel-sparkle", dur: "3s", del: "0.2s" },
      { name: "pixel-sparkle", dur: "3.5s", del: "1.8s" },
      { name: "pixel-sparkle", dur: "2.8s", del: "0.9s" },
      { name: "pixel-sparkle", dur: "3.2s", del: "1.4s" },
      { name: "pixel-sparkle", dur: "2.5s", del: "0.6s" },
      { name: "pixel-sparkle", dur: "3.8s", del: "2.2s" },
      { name: "pixel-sparkle", dur: "2.6s", del: "0.4s" },
      { name: "pixel-sparkle", dur: "3.1s", del: "1.6s" },
      { name: "pixel-sparkle", dur: "2.9s", del: "1.0s" },
    ],
  },
};

export function PixelGrid({
  variant,
  size = 24,
  peakOpacity = 1,
  glowBlur = 4,
  glowSpread = 1,
  className,
}: PixelGridProps) {
  const config = VARIANTS[variant];
  const cellSize = size / 3;

  return (
    <div
      className={cn("grid transform-gpu grid-cols-3", className)}
      style={
        {
          width: size,
          height: size,
          gap: 0,
          "--pixel-glow": config.color,
          "--pixel-peak-opacity": peakOpacity,
          "--pixel-glow-blur": `${glowBlur}px`,
          "--pixel-glow-spread": `${glowSpread}px`,
        } as React.CSSProperties
      }
      aria-hidden="true"
    >
      {config.cells.map((cell, i) => (
        <div
          key={i}
          style={{
            width: cellSize,
            height: cellSize,
            backgroundColor: config.color,
            opacity: 0,
            ...(cell
              ? {
                  animation: `${cell.name} ${cell.dur} ease-in-out infinite`,
                  animationDelay: cell.del,
                }
              : {}),
          }}
        />
      ))}
    </div>
  );
}
