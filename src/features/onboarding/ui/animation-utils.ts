/**
 * Standalone animation utilities — zero dependencies.
 * Replaces Remotion's spring(), interpolate(), and Easing.* for runtime use.
 */

// ── Easing functions ──

export const Easing = {
  linear: (t: number) => t,
  quad: (t: number) => t * t,
  cubic: (t: number) => t * t * t,
  exp: (t: number) => (t === 0 ? 0 : Math.pow(2, 10 * (t - 1))),
  in: (fn: (t: number) => number) => fn,
  out: (fn: (t: number) => number) => (t: number) => 1 - fn(1 - t),
  inOut: (fn: (t: number) => number) => (t: number) =>
    t < 0.5 ? fn(t * 2) / 2 : 1 - fn((1 - t) * 2) / 2,
  bezier: (x1: number, y1: number, x2: number, y2: number) => {
    // Newton-Raphson cubic bezier solver
    return (t: number) => {
      if (t === 0 || t === 1) return t;
      let lo = 0,
        hi = 1;
      for (let i = 0; i < 20; i++) {
        const mid = (lo + hi) / 2;
        const x = cubicBezierX(mid, x1, x2);
        if (Math.abs(x - t) < 1e-6) return cubicBezierY(mid, y1, y2);
        if (x < t) lo = mid;
        else hi = mid;
      }
      return cubicBezierY((lo + hi) / 2, y1, y2);
    };
  },
};

function cubicBezierX(t: number, x1: number, x2: number) {
  return 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t;
}

function cubicBezierY(t: number, y1: number, y2: number) {
  return 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t;
}

// ── Interpolation (clamped lerp with easing) ──

export function interpolate(
  value: number,
  inputRange: [number, number],
  outputRange: [number, number],
  options?: { easing?: (t: number) => number }
): number {
  const [inMin, inMax] = inputRange;
  const [outMin, outMax] = outputRange;

  // Clamp input
  const clamped = Math.max(inMin, Math.min(inMax, value));
  let t = inMax === inMin ? 0 : (clamped - inMin) / (inMax - inMin);

  if (options?.easing) t = options.easing(t);

  return outMin + t * (outMax - outMin);
}

// ── Spring physics (damped harmonic oscillator) ──

export function spring(
  frame: number,
  fps: number,
  config: { damping: number; stiffness: number; mass: number },
  durationInFrames: number
): number {
  if (frame <= 0) return 0;

  const { damping, stiffness, mass } = config;
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));

  const maxFrame = Math.min(frame, durationInFrames);
  const t = maxFrame / fps;

  let value: number;
  if (zeta < 1) {
    // Underdamped
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    value =
      1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
  } else if (zeta === 1) {
    // Critically damped
    value = 1 - Math.exp(-w0 * t) * (1 + w0 * t);
  } else {
    // Overdamped
    const s1 = -w0 * (zeta - Math.sqrt(zeta * zeta - 1));
    const s2 = -w0 * (zeta + Math.sqrt(zeta * zeta - 1));
    value = 1 - (s2 * Math.exp(s1 * t) - s1 * Math.exp(s2 * t)) / (s2 - s1);
  }

  return Math.max(0, value);
}
