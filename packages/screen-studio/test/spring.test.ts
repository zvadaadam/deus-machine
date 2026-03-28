import { describe, it, expect } from "vitest";
import { Spring, SPRING_PRESETS } from "../src/camera/spring.js";

describe("Spring", () => {
  describe("underdamped (zeta < 1)", () => {
    const spring = new Spring({ omega: 8, zeta: 0.7 });

    it("converges to target from displacement", () => {
      let pos = 0;
      let vel = 0;
      const target = 100;
      const dt = 1 / 60;

      // Simulate 3 seconds (should be well settled)
      for (let i = 0; i < 180; i++) {
        [pos, vel] = spring.step(pos, vel, target, dt);
      }

      expect(pos).toBeCloseTo(target, 1);
      expect(Math.abs(vel)).toBeLessThan(0.5);
    });

    it("overshoots the target (underdamped behavior)", () => {
      // Use a more underdamped spring to see clear overshoot
      const bouncy = new Spring({ omega: 12, zeta: 0.3 });
      let pos = 0;
      let vel = 0;
      const target = 100;
      const dt = 1 / 60;
      let maxPos = 0;

      for (let i = 0; i < 120; i++) {
        [pos, vel] = bouncy.step(pos, vel, target, dt);
        maxPos = Math.max(maxPos, pos);
      }

      // Underdamped springs overshoot
      expect(maxPos).toBeGreaterThan(target);
    });

    it("handles zero displacement (already at target)", () => {
      const [pos, vel] = spring.step(100, 0, 100, 1 / 60);
      expect(pos).toBe(100);
      expect(vel).toBe(0);
    });

    it("handles negative displacement", () => {
      let pos = 200;
      let vel = 0;
      const target = 100;
      const dt = 1 / 60;

      for (let i = 0; i < 180; i++) {
        [pos, vel] = spring.step(pos, vel, target, dt);
      }

      expect(pos).toBeCloseTo(target, 1);
    });

    it("handles initial velocity", () => {
      let pos = 0;
      let vel = 500; // launching toward target
      const target = 100;
      const dt = 1 / 60;

      // With positive initial velocity, should reach target faster
      let frames = 0;
      while (Math.abs(pos - target) > 1 && frames < 300) {
        [pos, vel] = spring.step(pos, vel, target, dt);
        frames++;
      }

      expect(frames).toBeLessThan(120); // Settles faster than from rest
      expect(Math.abs(pos - target)).toBeLessThan(2);
    });

    it("is stable with large dt", () => {
      // Analytical solution should be stable even with large timesteps
      const [pos, vel] = spring.step(0, 0, 100, 1.0); // 1 second step
      expect(Number.isFinite(pos)).toBe(true);
      expect(Number.isFinite(vel)).toBe(true);
    });

    it("returns unchanged for dt = 0", () => {
      const [pos, vel] = spring.step(50, 10, 100, 0);
      expect(pos).toBe(50);
      expect(vel).toBe(10);
    });
  });

  describe("overdamped (zeta > 1)", () => {
    const spring = new Spring({ omega: 8, zeta: 1.5 });

    it("converges without oscillation", () => {
      let pos = 0;
      let vel = 0;
      const target = 100;
      const dt = 1 / 60;
      let prevDist = Infinity;
      let monotonic = true;

      for (let i = 0; i < 180; i++) {
        [pos, vel] = spring.step(pos, vel, target, dt);
        const dist = Math.abs(pos - target);
        // Once close enough, allow tiny numerical noise
        if (dist > 0.01 && dist > prevDist + 0.001) {
          monotonic = false;
        }
        prevDist = dist;
      }

      expect(monotonic).toBe(true);
      expect(pos).toBeCloseTo(target, 1);
    });
  });

  describe("critically damped (zeta = 1)", () => {
    const spring = new Spring({ omega: 8, zeta: 1.0 });

    it("converges to target", () => {
      let pos = 0;
      let vel = 0;
      const target = 100;
      const dt = 1 / 60;

      for (let i = 0; i < 180; i++) {
        [pos, vel] = spring.step(pos, vel, target, dt);
      }

      expect(pos).toBeCloseTo(target, 1);
    });

    it("is the fastest non-oscillating response", () => {
      // Critically damped should settle faster than overdamped
      const overdamped = new Spring({ omega: 8, zeta: 2.0 });

      let critPos = 0, critVel = 0;
      let overPos = 0, overVel = 0;
      const dt = 1 / 60;

      // After 30 frames, critically damped should be closer to target
      for (let i = 0; i < 30; i++) {
        [critPos, critVel] = spring.step(critPos, critVel, 100, dt);
        [overPos, overVel] = overdamped.step(overPos, overVel, 100, dt);
      }

      expect(Math.abs(critPos - 100)).toBeLessThan(Math.abs(overPos - 100));
    });
  });

  describe("isSettled", () => {
    const spring = new Spring(SPRING_PRESETS.camera);

    it("returns true when at target with no velocity", () => {
      expect(spring.isSettled(100, 0, 100)).toBe(true);
    });

    it("returns false when far from target", () => {
      expect(spring.isSettled(0, 0, 100)).toBe(false);
    });

    it("returns false when moving fast", () => {
      expect(spring.isSettled(100, 50, 100)).toBe(false);
    });

    it("respects custom threshold", () => {
      expect(spring.isSettled(99, 0.1, 100, 2)).toBe(true);
      expect(spring.isSettled(97, 0.1, 100, 2)).toBe(false);
    });
  });

  describe("SPRING_PRESETS", () => {
    it("all presets produce valid springs", () => {
      for (const [name, config] of Object.entries(SPRING_PRESETS)) {
        const spring = new Spring(config);
        let pos = 0, vel = 0;

        // Run for 10 seconds to ensure all presets settle (cinematic is slow)
        for (let i = 0; i < 600; i++) {
          [pos, vel] = spring.step(pos, vel, 100, 1 / 60);
        }

        expect(
          Math.abs(pos - 100),
          `${name} preset should converge`,
        ).toBeLessThan(1);
        expect(
          Math.abs(vel),
          `${name} preset should settle`,
        ).toBeLessThan(1);
      }
    });
  });
});
