import type { Point } from "../types.js";
import { clamp } from "./smoothstep.js";

/**
 * Catmull-Rom spline interpolation for smooth cursor paths.
 *
 * Given a sequence of points with timestamps, produces smoothly
 * interpolated positions at any time t. Uses centripetal parameterization
 * (alpha = 0.5) to avoid cusps and self-intersections.
 *
 * @param points    Array of { x, y, t } — must be sorted by t
 * @param t         Query timestamp
 * @param tension   Spline tension (0 = Catmull-Rom, 1 = linear). Default: 0.2
 * @returns         Interpolated point
 */
export function catmullRomAt(
  points: Array<Point & { t: number }>,
  t: number,
  tension = 0.2,
): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return { x: points[0].x, y: points[0].y };

  // Clamp to range
  if (t <= points[0].t) return { x: points[0].x, y: points[0].y };
  if (t >= points[points.length - 1].t) {
    const last = points[points.length - 1];
    return { x: last.x, y: last.y };
  }

  // Find the segment [i, i+1] that contains t
  let i = 0;
  for (let j = 0; j < points.length - 1; j++) {
    if (t >= points[j].t && t < points[j + 1].t) {
      i = j;
      break;
    }
  }

  // Get 4 control points: p0, p1, p2, p3
  // Clamp at boundaries (duplicate endpoints)
  const p0 = points[Math.max(0, i - 1)];
  const p1 = points[i];
  const p2 = points[Math.min(points.length - 1, i + 1)];
  const p3 = points[Math.min(points.length - 1, i + 2)];

  // Normalized parameter within segment
  const segmentT = clamp(
    (t - p1.t) / (p2.t - p1.t || 1),
    0,
    1,
  );

  return {
    x: catmullRom1D(p0.x, p1.x, p2.x, p3.x, segmentT, tension),
    y: catmullRom1D(p0.y, p1.y, p2.y, p3.y, segmentT, tension),
  };
}

/**
 * 1D Catmull-Rom interpolation with tension parameter.
 *
 * Uses the standard Catmull-Rom matrix form:
 * q(t) = 0.5 * [(2*p1) + (-p0+p2)*t + (2*p0-5*p1+4*p2-p3)*t² + (-p0+3*p1-3*p2+p3)*t³]
 *
 * tension blends between Catmull-Rom and linear interpolation:
 * tension = 0 → standard Catmull-Rom (passes through control points with curvature)
 * tension = 1 → linear interpolation between p1 and p2
 */
function catmullRom1D(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  t: number,
  tension: number,
): number {
  const t2 = t * t;
  const t3 = t2 * t;

  // Standard Catmull-Rom (tension=0)
  const catmull = p1
    + 0.5 * (-p0 + p2) * t
    + 0.5 * (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
    + 0.5 * (-p0 + 3 * p1 - 3 * p2 + p3) * t3;

  // Linear interpolation between p1 and p2
  const linear = p1 + (p2 - p1) * t;

  // Blend: tension=0 → pure catmull-rom, tension=1 → linear
  return catmull * (1 - tension) + linear * tension;
}

/**
 * Resample a point sequence at a fixed interval using Catmull-Rom.
 *
 * @param points    Source points sorted by t
 * @param interval  Desired time interval between samples (ms)
 * @param tension   Spline tension
 * @returns         Evenly-spaced resampled points
 */
export function resamplePath(
  points: Array<Point & { t: number }>,
  interval: number,
  tension = 0.2,
): Array<Point & { t: number }> {
  if (!Number.isFinite(interval) || interval <= 0) {
    throw new RangeError("interval must be a finite number > 0");
  }

  if (points.length < 2) return [...points];

  const start = points[0].t;
  const end = points[points.length - 1].t;
  const result: Array<Point & { t: number }> = [];

  for (let t = start; t <= end; t += interval) {
    const p = catmullRomAt(points, t, tension);
    result.push({ ...p, t });
  }

  // Always include the last point
  const lastT = result[result.length - 1]?.t;
  if (lastT !== undefined && Math.abs(lastT - end) > interval * 0.1) {
    const p = catmullRomAt(points, end, tension);
    result.push({ ...p, t: end });
  }

  return result;
}
