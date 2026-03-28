import { describe, it, expect } from "vitest";
import { ShotPlanner } from "../src/intent/shot-planner.js";
import type { Intent } from "../src/types.js";

describe("ShotPlanner", () => {
  const planner = new ShotPlanner({
    sourceSize: { width: 1920, height: 1080 },
  });

  it("assigns higher zoom for typing than scrolling", () => {
    const typing: Intent = {
      type: "typing",
      startT: 0,
      endT: 1000,
      center: { x: 500, y: 300 },
      zoom: 1,
      bounds: { x: 400, y: 250, width: 300, height: 50 },
    };

    const scrolling: Intent = {
      type: "scrolling",
      startT: 0,
      endT: 1000,
      center: { x: 500, y: 300 },
      zoom: 1,
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    };

    const typingZoom = planner.computeZoom(typing);
    const scrollingZoom = planner.computeZoom(scrolling);

    expect(typingZoom).toBeGreaterThan(scrollingZoom);
  });

  it("zooms in more for smaller elements", () => {
    const small: Intent = {
      type: "clicking",
      startT: 0,
      endT: 100,
      center: { x: 500, y: 300 },
      zoom: 1,
      bounds: { x: 490, y: 290, width: 50, height: 30 },
    };

    const large: Intent = {
      type: "clicking",
      startT: 0,
      endT: 100,
      center: { x: 500, y: 300 },
      zoom: 1,
      bounds: { x: 200, y: 100, width: 800, height: 600 },
    };

    const smallZoom = planner.computeZoom(small);
    const largeZoom = planner.computeZoom(large);

    expect(smallZoom).toBeGreaterThan(largeZoom);
  });

  it("respects min and max zoom bounds", () => {
    const planner = new ShotPlanner({ minZoom: 1.0, maxZoom: 3.0 });

    const intent: Intent = {
      type: "typing",
      startT: 0,
      endT: 1000,
      center: { x: 500, y: 300 },
      zoom: 1,
      bounds: { x: 499, y: 299, width: 2, height: 2 }, // Tiny — would want huge zoom
    };

    const zoom = planner.computeZoom(intent);
    expect(zoom).toBeLessThanOrEqual(3.0);
    expect(zoom).toBeGreaterThanOrEqual(1.0);
  });

  it("idle intent defaults to zoom 1", () => {
    const idle: Intent = {
      type: "idle",
      startT: 0,
      endT: 5000,
      center: { x: 960, y: 540 },
      zoom: 1,
    };

    const zoom = planner.computeZoom(idle);
    expect(zoom).toBe(1.0);
  });

  it("plan() mutates zoom on all intents", () => {
    const intents: Intent[] = [
      {
        type: "clicking",
        startT: 0,
        endT: 100,
        center: { x: 500, y: 300 },
        zoom: 1,
        bounds: { x: 450, y: 250, width: 200, height: 100 },
      },
      {
        type: "typing",
        startT: 200,
        endT: 2000,
        center: { x: 500, y: 300 },
        zoom: 1,
        bounds: { x: 400, y: 280, width: 300, height: 40 },
      },
    ];

    const result = planner.plan(intents);
    expect(result).toBe(intents); // mutates in place
    expect(intents[0].zoom).toBeGreaterThan(1);
    expect(intents[1].zoom).toBeGreaterThan(1);
  });

  it("getRange returns correct ranges", () => {
    expect(planner.getRange("typing")).toEqual([2.0, 2.5]);
    expect(planner.getRange("idle")).toEqual([1.0, 1.0]);
  });
});
