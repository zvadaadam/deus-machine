/**
 * CircularPixelGrid — Canvas-based high-resolution pixel grid inside a circle.
 *
 * Redesign of the 3×3 PixelGrid: same 6 variants, but rendered at 8–32×
 * resolution inside a circular mask. Uses <canvas> + requestAnimationFrame
 * for smooth 60fps with hundreds of cells.
 *
 * Each variant maps (cell position, time) → opacity, producing:
 *   thinking      : radial breathing (blue)  — center bright, outer subtle
 *   generating    : random sparkle (green)   — organic twinkling sphere
 *   toolExecuting : clockwise sweep (amber)  — radar-scan with tail
 *   error         : cross pulse (red)        — axis-aligned + pattern
 *   compacting    : ring collapse (violet)   — concentric rings inward
 *   working       : shimmer waves (gray)     — sidebar ambient indicator
 */

import { useRef, useEffect, useMemo } from "react";
import { cn } from "@/shared/lib/utils";

export type CircularPixelGridVariant =
  | "thinking"
  | "generating"
  | "toolExecuting"
  | "error"
  | "compacting"
  | "working";

interface CircularPixelGridProps {
  variant: CircularPixelGridVariant;
  /** Total diameter in CSS px (default 24) */
  size?: number;
  /** Grid cells per axis — 8 to 32 (default 16) */
  resolution?: number;
  /** Gap between cells as fraction of cell size [0, 1) (default 0.2) */
  gap?: number;
  /** "square" pixels or "round" dots (default "square") */
  dotShape?: "square" | "round";
  /** Override color — CSS color string (e.g. "oklch(0.65 0.15 265)").
   *  When set, bypasses the variant's CSS variable. */
  color?: string;
  className?: string;
}

/* ── Variant colors ───────────────────────────────────────── */
// cssVar: resolved from the theme (respects light/dark mode)
// direct: hardcoded oklch color (used when no semantic token exists)

const VARIANT_COLORS: Record<CircularPixelGridVariant, { cssVar?: string; direct?: string }> = {
  thinking: { direct: "oklch(0.68 0.14 265)" }, // indigo — Option A
  generating: { cssVar: "--success" },
  toolExecuting: { cssVar: "--warning" },
  error: { cssVar: "--destructive" },
  compacting: { direct: "oklch(0.68 0.14 300)" }, // violet — Option A
  working: { cssVar: "--muted-foreground" }, // neutral gray
};

/* ── Pre-computed cell metadata ────────────────────────────── */

interface Cell {
  col: number;
  row: number;
  /** Normalized x from center [-1, 1] */
  nx: number;
  /** Normalized y from center [-1, 1] */
  ny: number;
  /** Distance from center [0, 1] */
  dist: number;
  /** Angle from center (radians) */
  angle: number;
  /** Deterministic pseudo-random [0, 1] */
  seed: number;
}

function buildCells(res: number): Cell[] {
  const out: Cell[] = [];
  const half = res / 2;
  for (let r = 0; r < res; r++) {
    for (let c = 0; c < res; c++) {
      const nx = (c + 0.5 - half) / half;
      const ny = (r + 0.5 - half) / half;
      const dist = Math.sqrt(nx * nx + ny * ny);
      if (dist <= 1.0) {
        out.push({
          col: c,
          row: r,
          nx,
          ny,
          dist,
          angle: Math.atan2(ny, nx),
          seed: ((c * 7919 + r * 6271 + c * r * 31) % 997) / 997,
        });
      }
    }
  }
  return out;
}

/* ── Animation functions: (cell, time) → opacity [0, 1] ──── */

function thinkingOp(c: Cell, t: number): number {
  const { dist, angle, seed } = c;

  // Rotating bright zone sweeps around the circle (~2.5s per revolution)
  const rotAngle = t * 0.4 * Math.PI * 2;
  let aDiff = angle - rotAngle;
  if (aDiff > Math.PI) aDiff -= Math.PI * 2;
  if (aDiff < -Math.PI) aDiff += Math.PI * 2;
  const rotWave = Math.pow((Math.cos(aDiff * 1.2) + 1) / 2, 0.8);

  // Radial pulse emanating outward from center (faster, ~1.2s cycle)
  const ripple = (Math.sin(t * 0.85 * Math.PI * 2 - dist * Math.PI * 2) + 1) / 2;

  // Combine: rotation gives sweeping shape, ripple gives radial energy
  const combined = rotWave * 0.55 + ripple * 0.45;

  // Center stays brighter, outer ring more dramatic contrast
  const distFactor = 0.4 + (1 - dist) * 0.6;

  // Per-cell flicker for "neural" feel
  const flicker = 0.85 + seed * 0.15;

  return combined * distFactor * flicker;
}

function generatingOp(c: Cell, t: number): number {
  const { seed, dist } = c;

  const freq = 0.25 + seed * 0.8;
  const phase = seed * Math.PI * 9.3;
  const raw = Math.sin(t * freq * Math.PI * 2 + phase);
  // Cube the positive half for sharp sparkle peaks
  const sparkle = Math.pow(Math.max(0, raw), 3);

  return sparkle * (0.65 + (1 - dist) * 0.35);
}

function toolExecutingOp(c: Cell, t: number): number {
  const { angle, dist } = c;

  // Clockwise sweep with a trailing tail
  const sweep = ((t * Math.PI * 2) / 2.4) % (Math.PI * 2);
  let diff = angle - sweep;
  if (diff > Math.PI) diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;

  const leading = 0.5;
  const trailing = 1.4;
  let intensity: number;
  if (diff >= 0 && diff < leading) {
    intensity = 1 - diff / leading;
  } else if (diff < 0 && diff > -trailing) {
    intensity = (1 + diff / trailing) * 0.5;
  } else {
    intensity = 0;
  }

  // Outer ring emphasis + subtle center ambient
  const radial = 0.25 + dist * 0.75;
  const centerGlow = (1 - dist) * 0.1;

  return Math.max(intensity * radial, centerGlow);
}

function errorOp(c: Cell, t: number): number {
  const { nx, ny, dist } = c;

  // Cross pattern via cartesian axes
  const armWidth = 0.3;
  const onH = Math.abs(ny) < armWidth ? 1 - Math.abs(ny) / armWidth : 0;
  const onV = Math.abs(nx) < armWidth ? 1 - Math.abs(nx) / armWidth : 0;
  const cross = Math.max(onH, onV);

  // Center dot always part of cross
  const center = dist < 0.15 ? 1 : 0;

  // Synchronized 2s pulse
  const pulse = (Math.sin(t * Math.PI) + 1) / 2;

  return Math.max(cross, center) * pulse;
}

function compactingOp(c: Cell, t: number): number {
  const { dist, seed } = c;

  // Two concentric rings cascading inward, offset by half-cycle
  const period = 3;
  const phase1 = (t / period) % 1;
  const phase2 = (t / period + 0.5) % 1;

  const ringWidth = 0.28;
  const ringIntensity = (ringPos: number) => {
    const d = Math.abs(dist - (1 - ringPos));
    return d < ringWidth ? 1 - d / ringWidth : 0;
  };

  const r1 = ringIntensity(phase1);
  const r2 = ringIntensity(phase2) * 0.6; // dimmer second ring

  return Math.max(r1, r2) * (0.85 + seed * 0.15);
}

/**
 * Sidebar "still working" — gray shimmer surface.
 *
 * Design: three wave planes at golden-angle offsets (≈137.5°) sweep
 * across the circle. Each wave uses a non-linear phase that surges
 * and eases but never stops. The interference creates a constantly
 * shifting shimmer — sometimes bright, sometimes fully dark.
 *
 * The power curve (^3) makes peaks sharp and valleys go to true zero,
 * so individual pixels pop in and out rather than just dimming.
 */
function workingOp(c: Cell, t: number): number {
  const { nx, ny, dist, seed } = c;

  // Three wave planes at golden-angle separations (0°, 137.5°, 275°)
  // Each with its own non-linear surge phase
  const p1 = t * 1.2 + (1 - Math.cos(t * 0.7)) * 0.9;
  const p2 = t * 0.9 + (1 - Math.cos(t * 0.5 + 2.0)) * 0.7;
  const p3 = t * 0.7 + (1 - Math.cos(t * 0.6 + 4.0)) * 0.5;

  // Wave directions at golden-angle offsets
  const d1 = nx * 1.0 + ny * 0.0; // horizontal
  const d2 = nx * -0.73 + ny * 0.68; // 137.5°
  const d3 = nx * -0.17 + ny * -0.98; // 275°

  const w1 = Math.sin(d1 * 3.5 - p1 * 2.2 + seed * 0.3);
  const w2 = Math.sin(d2 * 3.0 - p2 * 2.5 + seed * 0.5);
  const w3 = Math.sin(d3 * 2.8 - p3 * 1.8 + seed * 0.2);

  // Combine — three-wave interference is richer than two
  const raw = (w1 * 0.4 + w2 * 0.35 + w3 * 0.25 + 1) / 2;

  // Cube: sharp peaks, true zero valleys — pixels pop in/out
  const shimmer = raw * raw * raw;

  // Edge fade
  const edge = dist < 0.85 ? 1 : 1 - (dist - 0.85) / 0.15;

  return shimmer * 0.65 * edge;
}

const OP_FN: Record<CircularPixelGridVariant, (c: Cell, t: number) => number> = {
  thinking: thinkingOp,
  generating: generatingOp,
  toolExecuting: toolExecutingOp,
  error: errorOp,
  compacting: compactingOp,
  working: workingOp,
};

/* ── Resolve CSS color → [r, g, b] ────────────────────────── */

/**
 * Convert any CSS color string (rgb, oklch, hex, etc.) to [r, g, b].
 * Modern browsers return oklch/lab from getComputedStyle — can't just
 * regex for integers. Drawing to a 1×1 canvas and reading back the
 * pixel handles every format the browser supports.
 */
function cssToRGB(cssColor: string): [number, number, number] {
  // Fast path: rgb(r, g, b) or rgba(r, g, b, a) — most common
  const rgbMatch = cssColor.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (rgbMatch) return [+rgbMatch[1], +rgbMatch[2], +rgbMatch[3]];

  // Slow path: oklch, lab, color(), hex, named — rasterize to get RGB
  const c = document.createElement("canvas");
  c.width = c.height = 1;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = cssColor;
  ctx.fillRect(0, 0, 1, 1);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  return [d[0], d[1], d[2]];
}

function resolveRGB(el: HTMLElement, cssVar: string): [number, number, number] {
  const prev = el.style.color;
  el.style.color = `var(${cssVar})`;
  const computed = getComputedStyle(el).color;
  el.style.color = prev;
  return cssToRGB(computed);
}

function resolveColorString(el: HTMLElement, color: string): [number, number, number] {
  const prev = el.style.color;
  el.style.color = color;
  const computed = getComputedStyle(el).color;
  el.style.color = prev;
  return cssToRGB(computed);
}

/* ── Component ────────────────────────────────────────────── */

export function CircularPixelGrid({
  variant,
  size = 24,
  resolution = 16,
  gap = 0.2,
  dotShape = "square",
  color,
  className,
}: CircularPixelGridProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef(0);
  const colorRef = useRef<[number, number, number]>([128, 128, 255]);

  const cells = useMemo(() => buildCells(resolution), [resolution]);

  // Resolve color from CSS variable or override (handles theme changes)
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;

    const resolve = () => {
      if (color) {
        colorRef.current = resolveColorString(el, color);
      } else {
        const vc = VARIANT_COLORS[variant];
        colorRef.current = vc.direct
          ? resolveColorString(el, vc.direct)
          : vc.cssVar
            ? resolveRGB(el, vc.cssVar)
            : [128, 128, 255];
      }
    };
    resolve();

    // Re-resolve on theme toggle (class change on <html>)
    const obs = new MutationObserver(resolve);
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => obs.disconnect();
  }, [variant, color]);

  // Canvas render loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const opFn = OP_FN[variant];
    const cellPx = size / resolution;
    const dotPx = cellPx * (1 - gap);
    const pad = (cellPx - dotPx) / 2;
    const half = size / 2;
    const isRound = dotShape === "round";
    const dotR = dotPx / 2;
    const glowR = dotR * 1.3;
    const glowExtra = dotPx * 0.4;

    const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const t0 = performance.now();

    function draw(now: number) {
      const t = prefersReduced ? 0 : (now - t0) / 1000;
      const [cr, cg, cb] = colorRef.current;

      ctx!.clearRect(0, 0, size, size);

      // Circular clip
      ctx!.save();
      ctx!.beginPath();
      ctx!.arc(half, half, half, 0, Math.PI * 2);
      ctx!.clip();

      // Faint background disk so the circle is visible when most cells are off
      ctx!.fillStyle = `rgba(${cr},${cg},${cb},0.04)`;
      ctx!.fill();

      for (let i = 0; i < cells.length; i++) {
        const cell = cells[i];
        const op = opFn(cell, t);
        if (op < 0.008) continue;
        const a = Math.min(1, op);

        const x = cell.col * cellPx + pad;
        const y = cell.row * cellPx + pad;

        if (isRound) {
          const cx = x + dotR;
          const cy = y + dotR;

          // Glow (larger, dimmer)
          ctx!.fillStyle = `rgba(${cr},${cg},${cb},${(a * 0.3).toFixed(3)})`;
          ctx!.beginPath();
          ctx!.arc(cx, cy, glowR, 0, Math.PI * 2);
          ctx!.fill();

          // Sharp dot
          ctx!.fillStyle = `rgba(${cr},${cg},${cb},${a.toFixed(3)})`;
          ctx!.beginPath();
          ctx!.arc(cx, cy, dotR, 0, Math.PI * 2);
          ctx!.fill();
        } else {
          // Glow rect (slightly larger + dimmer)
          ctx!.fillStyle = `rgba(${cr},${cg},${cb},${(a * 0.3).toFixed(3)})`;
          ctx!.fillRect(x - glowExtra / 2, y - glowExtra / 2, dotPx + glowExtra, dotPx + glowExtra);

          // Sharp pixel
          ctx!.fillStyle = `rgba(${cr},${cg},${cb},${a.toFixed(3)})`;
          ctx!.fillRect(x, y, dotPx, dotPx);
        }
      }

      ctx!.restore();
      frameRef.current = requestAnimationFrame(draw);
    }

    frameRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frameRef.current);
  }, [variant, size, resolution, gap, dotShape, cells]);

  return (
    <canvas
      ref={canvasRef}
      className={cn("transform-gpu", className)}
      style={{ width: size, height: size, borderRadius: "50%" }}
      aria-hidden="true"
    />
  );
}
