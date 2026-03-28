import { describe, it, expect } from "vitest";
import {
  smoothstep,
  smootherstep,
  clamp,
  lerp,
  inverseLerp,
  remap,
} from "../src/interpolation/smoothstep.js";
import { catmullRomAt, resamplePath } from "../src/interpolation/catmull-rom.js";

describe("smoothstep", () => {
  it("returns 0 below edge0", () => {
    expect(smoothstep(0, 1, -0.5)).toBe(0);
  });

  it("returns 1 above edge1", () => {
    expect(smoothstep(0, 1, 1.5)).toBe(1);
  });

  it("returns 0.5 at midpoint", () => {
    expect(smoothstep(0, 1, 0.5)).toBe(0.5);
  });

  it("returns 0 when edge0 === edge1 (division by zero guard)", () => {
    expect(smoothstep(5, 5, 5)).toBe(0);
  });

  it("returns 0 when edge0 === edge1 === 0", () => {
    expect(smoothstep(0, 0, 1)).toBe(0);
  });

  it("has zero derivative at edges", () => {
    // smoothstep derivative = 6t(1-t), which is 0 at t=0 and t=1
    const epsilon = 0.001;
    const slopeAtStart = (smoothstep(0, 1, epsilon) - smoothstep(0, 1, 0)) / epsilon;
    const slopeAtEnd = (smoothstep(0, 1, 1) - smoothstep(0, 1, 1 - epsilon)) / epsilon;
    expect(Math.abs(slopeAtStart)).toBeLessThan(0.01);
    expect(Math.abs(slopeAtEnd)).toBeLessThan(0.01);
  });
});

describe("smootherstep", () => {
  it("returns 0 below edge0", () => {
    expect(smootherstep(0, 1, -0.5)).toBe(0);
  });

  it("returns 1 above edge1", () => {
    expect(smootherstep(0, 1, 1.5)).toBe(1);
  });

  it("returns 0.5 at midpoint", () => {
    expect(smootherstep(0, 1, 0.5)).toBe(0.5);
  });

  it("returns 0 when edge0 === edge1 (division by zero guard)", () => {
    expect(smootherstep(5, 5, 5)).toBe(0);
  });
});

describe("clamp", () => {
  it("clamps below min", () => expect(clamp(-5, 0, 10)).toBe(0));
  it("clamps above max", () => expect(clamp(15, 0, 10)).toBe(10));
  it("passes through in range", () => expect(clamp(5, 0, 10)).toBe(5));
  it("handles equal min/max", () => expect(clamp(5, 3, 3)).toBe(3));
});

describe("lerp", () => {
  it("returns a at t=0", () => expect(lerp(10, 20, 0)).toBe(10));
  it("returns b at t=1", () => expect(lerp(10, 20, 1)).toBe(20));
  it("interpolates at t=0.5", () => expect(lerp(10, 20, 0.5)).toBe(15));
  it("extrapolates beyond [0,1]", () => expect(lerp(10, 20, 2)).toBe(30));
});

describe("inverseLerp", () => {
  it("returns 0 at a", () => expect(inverseLerp(10, 20, 10)).toBe(0));
  it("returns 1 at b", () => expect(inverseLerp(10, 20, 20)).toBe(1));
  it("returns 0.5 at midpoint", () => expect(inverseLerp(10, 20, 15)).toBe(0.5));
  it("handles equal a and b", () => expect(inverseLerp(5, 5, 5)).toBe(0));
});

describe("remap", () => {
  it("remaps from one range to another", () => {
    expect(remap(5, 0, 10, 100, 200)).toBe(150);
  });
  it("handles inverted ranges", () => {
    expect(remap(0, 0, 10, 200, 100)).toBe(200);
    expect(remap(10, 0, 10, 200, 100)).toBe(100);
  });
});

describe("catmullRomAt", () => {
  const points = [
    { x: 0, y: 0, t: 0 },
    { x: 100, y: 0, t: 1000 },
    { x: 100, y: 100, t: 2000 },
    { x: 0, y: 100, t: 3000 },
  ];

  it("returns first point before start", () => {
    const p = catmullRomAt(points, -100);
    expect(p.x).toBe(0);
    expect(p.y).toBe(0);
  });

  it("returns last point after end", () => {
    const p = catmullRomAt(points, 4000);
    expect(p.x).toBe(0);
    expect(p.y).toBe(100);
  });

  it("interpolates between points", () => {
    const p = catmullRomAt(points, 500); // midpoint of first segment
    expect(p.x).toBeGreaterThan(0);
    expect(p.x).toBeLessThan(100);
  });

  it("passes through control points (approximately)", () => {
    // Catmull-Rom passes through p1 and p2 (control points)
    const p = catmullRomAt(points, 1000);
    expect(p.x).toBeCloseTo(100, 0);
    expect(p.y).toBeCloseTo(0, 0);
  });

  it("handles single point", () => {
    const p = catmullRomAt([{ x: 50, y: 50, t: 0 }], 100);
    expect(p.x).toBe(50);
    expect(p.y).toBe(50);
  });

  it("handles empty array", () => {
    const p = catmullRomAt([], 100);
    expect(p.x).toBe(0);
    expect(p.y).toBe(0);
  });

  it("tension=1 produces linear interpolation", () => {
    // With tension=1, result should be a linear blend between p1 and p2
    const linearPoints = [
      { x: 0, y: 0, t: 0 },
      { x: 0, y: 0, t: 1000 },
      { x: 100, y: 200, t: 2000 },
      { x: 200, y: 400, t: 3000 },
    ];

    // Query at midpoint of segment [1]->[2] (t=1500)
    const p = catmullRomAt(linearPoints, 1500, 1.0);

    // Linear interpolation between (0,0) and (100,200) at t=0.5 → (50,100)
    expect(p.x).toBeCloseTo(50, 1);
    expect(p.y).toBeCloseTo(100, 1);
  });

  it("tension=1 does not collapse to constant", () => {
    // Regression: tension=1 used to make s=0 which collapsed all terms,
    // returning p1 regardless of t. Now it should give linear interpolation.
    const p25 = catmullRomAt(points, 250, 1.0);  // 25% into first segment
    const p75 = catmullRomAt(points, 750, 1.0);  // 75% into first segment

    // Both should be between p1.x=0 and p2.x=100, and different from each other
    expect(p25.x).toBeGreaterThan(0);
    expect(p75.x).toBeGreaterThan(p25.x);
    expect(p75.x).toBeLessThan(100);
  });
});

describe("resamplePath", () => {
  const points = [
    { x: 0, y: 0, t: 0 },
    { x: 100, y: 100, t: 1000 },
  ];

  it("produces evenly spaced points", () => {
    const resampled = resamplePath(points, 250); // 250ms interval
    expect(resampled.length).toBeGreaterThanOrEqual(4); // 0, 250, 500, 750, 1000
    expect(resampled.length).toBeLessThanOrEqual(6);

    // Check time spacing
    for (let i = 1; i < resampled.length - 1; i++) {
      const dt = resampled[i].t - resampled[i - 1].t;
      expect(dt).toBeCloseTo(250, 0);
    }
  });

  it("includes endpoints", () => {
    const resampled = resamplePath(points, 300);
    expect(resampled[0].t).toBe(0);
    expect(resampled[resampled.length - 1].t).toBeCloseTo(1000, 0);
  });

  it("handles single point", () => {
    const resampled = resamplePath([{ x: 50, y: 50, t: 0 }], 100);
    expect(resampled.length).toBe(1);
  });

  it("throws on zero interval", () => {
    expect(() => resamplePath(points, 0)).toThrow(RangeError);
  });

  it("throws on negative interval", () => {
    expect(() => resamplePath(points, -100)).toThrow(RangeError);
  });

  it("throws on NaN interval", () => {
    expect(() => resamplePath(points, NaN)).toThrow(RangeError);
  });

  it("throws on Infinity interval", () => {
    expect(() => resamplePath(points, Infinity)).toThrow(RangeError);
  });
});
