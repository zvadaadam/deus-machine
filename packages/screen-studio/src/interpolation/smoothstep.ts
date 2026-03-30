/**
 * Hermite smoothstep interpolation.
 * Returns 0 when x ≤ edge0, 1 when x ≥ edge1,
 * and smoothly interpolates between using 3t² - 2t³.
 */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (Math.abs(edge1 - edge0) < 1e-10) return 0;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Ken Perlin's improved smootherstep (5th-order polynomial).
 * Smoother than smoothstep — first AND second derivative are zero at edges.
 * Uses 6t⁵ - 15t⁴ + 10t³.
 */
export function smootherstep(edge0: number, edge1: number, x: number): number {
  if (Math.abs(edge1 - edge0) < 1e-10) return 0;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Clamp a value between min and max. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Linear interpolation between a and b by t ∈ [0, 1]. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Inverse linear interpolation: returns t such that lerp(a, b, t) = value. */
export function inverseLerp(a: number, b: number, value: number): number {
  if (Math.abs(b - a) < 1e-10) return 0;
  return (value - a) / (b - a);
}

/** Remap a value from [inMin, inMax] to [outMin, outMax]. */
export function remap(
  value: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
): number {
  const t = inverseLerp(inMin, inMax, value);
  return lerp(outMin, outMax, t);
}
