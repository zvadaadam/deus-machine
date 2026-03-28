import type { SpringConfig } from "../types.js";

/**
 * Analytical damped harmonic oscillator.
 *
 * Solves the spring equation: x'' + 2ζωx' + ω²x = 0
 * where ζ is damping ratio, ω is natural frequency.
 *
 * Uses the closed-form solution (not Euler integration) for stability
 * at any timestep. Handles both underdamped (ζ < 1) and overdamped (ζ ≥ 1).
 *
 * Ported from Screenize's SpringDamperSimulator.
 */
export class Spring {
  readonly omega: number;
  readonly zeta: number;

  constructor(config: SpringConfig) {
    this.omega = config.omega;
    this.zeta = config.zeta;
  }

  /**
   * Advance the spring by `dt` seconds.
   *
   * @param position  Current position
   * @param velocity  Current velocity
   * @param target    Target (equilibrium) position
   * @param dt        Time step in seconds
   * @returns         [newPosition, newVelocity]
   */
  step(
    position: number,
    velocity: number,
    target: number,
    dt: number,
  ): [number, number] {
    if (dt <= 0) return [position, velocity];

    const displacement = position - target;

    // Early exit: already at rest
    if (
      Math.abs(displacement) < 1e-6 &&
      Math.abs(velocity) < 1e-6
    ) {
      return [target, 0];
    }

    if (this.zeta >= 1) {
      return this.stepOverdamped(displacement, velocity, target, dt);
    }
    return this.stepUnderdamped(displacement, velocity, target, dt);
  }

  /**
   * Underdamped regime (ζ < 1): oscillation with exponential decay.
   *
   * Solution: x(t) = e^(-ζωt) [A cos(ωd·t) + B sin(ωd·t)]
   * where ωd = ω√(1-ζ²) is the damped frequency.
   */
  private stepUnderdamped(
    displacement: number,
    velocity: number,
    target: number,
    dt: number,
  ): [number, number] {
    const { omega, zeta } = this;
    const dampedOmega = omega * Math.sqrt(1 - zeta * zeta);
    const decay = Math.exp(-zeta * omega * dt);
    const cos = Math.cos(dampedOmega * dt);
    const sin = Math.sin(dampedOmega * dt);

    // Coefficients from initial conditions: x(0) = displacement, x'(0) = velocity
    const A = displacement;
    const B = (velocity + zeta * omega * displacement) / dampedOmega;

    const newDisplacement = decay * (A * cos + B * sin);
    const newVelocity =
      decay *
      (velocity * cos -
        (displacement * omega * omega / dampedOmega +
          (velocity * zeta * omega) / dampedOmega) *
          sin);

    return [target + newDisplacement, newVelocity];
  }

  /**
   * Overdamped regime (ζ ≥ 1): exponential decay, no oscillation.
   *
   * Solution: x(t) = C₁·e^(r₁·t) + C₂·e^(r₂·t)
   * where r₁,r₂ = -ζω ± ω√(ζ²-1)
   */
  private stepOverdamped(
    displacement: number,
    velocity: number,
    target: number,
    dt: number,
  ): [number, number] {
    const { omega, zeta } = this;

    if (Math.abs(zeta - 1) < 1e-6) {
      // Critically damped (ζ = 1): x(t) = (C₁ + C₂·t)·e^(-ωt)
      const expTerm = Math.exp(-omega * dt);
      const C1 = displacement;
      const C2 = velocity + omega * displacement;

      const newPos = (C1 + C2 * dt) * expTerm;
      const newVel = (C2 - omega * (C1 + C2 * dt)) * expTerm;
      return [target + newPos, newVel];
    }

    const sqrtTerm = omega * Math.sqrt(zeta * zeta - 1);
    const r1 = -zeta * omega + sqrtTerm;
    const r2 = -zeta * omega - sqrtTerm;

    // From initial conditions: C₁ + C₂ = displacement, r₁C₁ + r₂C₂ = velocity
    const C1 = (velocity - r2 * displacement) / (r1 - r2);
    const C2 = displacement - C1;

    const e1 = Math.exp(r1 * dt);
    const e2 = Math.exp(r2 * dt);

    const newPos = C1 * e1 + C2 * e2;
    const newVel = C1 * r1 * e1 + C2 * r2 * e2;

    return [target + newPos, newVel];
  }

  /**
   * Check if the spring has settled (position ≈ target, velocity ≈ 0).
   */
  isSettled(
    position: number,
    velocity: number,
    target: number,
    threshold = 0.5,
  ): boolean {
    return (
      Math.abs(position - target) < threshold &&
      Math.abs(velocity) < threshold
    );
  }
}

// Default spring configs for different contexts
export const SPRING_PRESETS = {
  /** Smooth camera following. Good default for auto-zoom. */
  camera: { omega: 8, zeta: 0.7 } satisfies SpringConfig,
  /** Snappy response for cursor smoothing. */
  cursor: { omega: 14, zeta: 0.85 } satisfies SpringConfig,
  /** Gentle zoom transitions. */
  zoom: { omega: 5, zeta: 0.8 } satisfies SpringConfig,
  /** Very smooth, cinematic panning. */
  cinematic: { omega: 4, zeta: 0.9 } satisfies SpringConfig,
} as const;
