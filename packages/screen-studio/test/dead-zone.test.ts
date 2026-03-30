import { describe, it, expect } from "vitest";
import { DeadZone, DEFAULT_DEAD_ZONE } from "../src/camera/dead-zone.js";

describe("DeadZone", () => {
  const viewport = { width: 1920, height: 1080 };
  const cameraCenter = { x: 960, y: 540 };

  it("returns camera position when target is inside dead zone", () => {
    const dz = new DeadZone({ fraction: 0.3, hysteresis: 0.03 });
    // Small movement within dead zone
    const target = dz.computeTarget(
      cameraCenter,
      { x: 970, y: 545 }, // 10px away — well within 30% of 960 = 288px
      viewport,
    );

    expect(target.x).toBe(cameraCenter.x);
    expect(target.y).toBe(cameraCenter.y);
  });

  it("moves camera when target is far outside dead zone", () => {
    const dz = new DeadZone({ fraction: 0.1, hysteresis: 0.01 });

    // Large movement way outside dead zone
    const target = dz.computeTarget(
      cameraCenter,
      { x: 1800, y: 900 }, // 840px away — well past 10% of 960 = 96px
      viewport,
    );

    // Should have moved toward the target
    expect(target.x).toBeGreaterThan(cameraCenter.x);
    expect(target.y).toBeGreaterThan(cameraCenter.y);
  });

  it("hysteresis prevents chattering at boundary", () => {
    const dz = new DeadZone({ fraction: 0.15, hysteresis: 0.05 });

    // Move just past the dead zone edge
    const safeHalf = viewport.width / 2 * 0.15; // 144
    const enterThreshold = safeHalf + viewport.width / 2 * 0.05; // 144 + 48 = 192

    // Just inside enter threshold — should stay inside
    const t1 = dz.computeTarget(
      cameraCenter,
      { x: cameraCenter.x + enterThreshold - 10, y: cameraCenter.y },
      viewport,
    );
    expect(t1.x).toBe(cameraCenter.x); // Still inside

    // Just past enter threshold — should leave
    const t2 = dz.computeTarget(
      cameraCenter,
      { x: cameraCenter.x + enterThreshold + 50, y: cameraCenter.y },
      viewport,
    );
    expect(t2.x).toBeGreaterThan(cameraCenter.x); // Now outside, camera follows
  });

  it("reset() puts dead zone back to inside state", () => {
    const dz = new DeadZone({ fraction: 0.1, hysteresis: 0.01 });

    // Force outside
    dz.computeTarget(cameraCenter, { x: 1800, y: 540 }, viewport);

    // Reset
    dz.reset();

    // Small movement should now be treated as inside
    const target = dz.computeTarget(
      cameraCenter,
      { x: 970, y: 540 },
      viewport,
    );
    expect(target.x).toBe(cameraCenter.x);
  });

  it("handles X and Y axes independently", () => {
    const dz = new DeadZone({ fraction: 0.1, hysteresis: 0.01 });

    // Move far in X but stay in Y
    const target = dz.computeTarget(
      cameraCenter,
      { x: 1800, y: 545 },
      viewport,
    );

    expect(target.x).toBeGreaterThan(cameraCenter.x); // X moved
    expect(target.y).toBe(cameraCenter.y); // Y stayed (inside dead zone)
  });

  it("DEFAULT_DEAD_ZONE values are reasonable", () => {
    expect(DEFAULT_DEAD_ZONE.fraction).toBeGreaterThan(0);
    expect(DEFAULT_DEAD_ZONE.fraction).toBeLessThan(0.5);
    expect(DEFAULT_DEAD_ZONE.hysteresis).toBeGreaterThan(0);
    expect(DEFAULT_DEAD_ZONE.hysteresis).toBeLessThan(DEFAULT_DEAD_ZONE.fraction);
  });
});
