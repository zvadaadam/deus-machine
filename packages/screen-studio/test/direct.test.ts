import { describe, expect, it } from "vitest";
import { cameraTrack } from "../src/direct/camera.js";
import { bezier, pointerTrack, touchTrack } from "../src/direct/cursor.js";
import { PRESETS } from "../src/direct/presets.js";
import { coverage, fitCamera, planShots } from "../src/direct/shots.js";
import type { TimelineAction } from "../src/edit/timeline.js";
import { computeLayout, resolveFrame } from "../src/render/layout.js";

const size = { width: 1280, height: 800 };
const camera = PRESETS.walkthrough.camera;
const cursor = PRESETS.walkthrough.cursor;
const act = (
  id: string,
  startMs: number,
  rect: TimelineAction["rect"],
  type: TimelineAction["type"] = "click"
): TimelineAction => ({
  id,
  type,
  startMs,
  endMs: startMs + 100,
  ...(rect ? { rect } : {}),
});

describe("shot planning", () => {
  it("frames nearby actions together, with a reason", () => {
    const { shots } = planShots({
      actions: [
        act("a", 2000, { x: 100, y: 100, width: 200, height: 40 }),
        act("b", 3000, { x: 100, y: 200, width: 200, height: 40 }),
      ],
      focus: [],
      size,
      durationMs: 6000,
      tokens: camera,
    });
    const framed = shots.find((s) => s.events.includes("a"))!;
    expect(framed.events).toEqual(["a", "b"]);
    expect(framed.camera.zoom).toBeGreaterThan(1.2);
    expect(framed.reason).toMatch(/frame the targets/);
    expect(coverage(framed.camera, { x: 100, y: 100, width: 200, height: 140 }, size)).toBe(1);
  });

  it("stays wide for page-level actions and returns wide when idle", () => {
    const { shots } = planShots({
      actions: [
        act("a", 1000, { x: 100, y: 100, width: 80, height: 30 }),
        act("nav", 9000, undefined, "navigate"),
      ],
      focus: [],
      size,
      durationMs: 12_000,
      tokens: camera,
    });
    const release = shots.find((s) => s.reason.startsWith("nothing nearby"))!;
    expect(release.atMs).toBe(2600);
    const activeAtNavigation = [...shots].reverse().find((s) => s.atMs <= 9000)!;
    expect(activeAtNavigation.camera.zoom).toBe(1);
    expect(activeAtNavigation.events).toContain("nav");
  });

  it("lets a focus hint override action framing", () => {
    const { shots } = planShots({
      actions: [
        act("a", 1000, { x: 50, y: 50, width: 80, height: 30 }),
        act("b", 4000, { x: 60, y: 60, width: 80, height: 30 }),
      ],
      focus: [
        {
          id: "f",
          atMs: 3500,
          durationMs: 2000,
          rect: { x: 900, y: 500, width: 300, height: 200 },
        },
      ],
      size,
      durationMs: 9000,
      tokens: camera,
    });
    const focus = shots.find((s) => s.events.includes("f"))!;
    expect(focus.reason).toMatch(/focus/);
    expect(shots.filter((s) => s.atMs > focus.atMs && s.atMs < 5500)).toHaveLength(0);
    expect(coverage(focus.camera, { x: 900, y: 500, width: 300, height: 200 }, size)).toBe(1);
  });

  it("drops shots that would never settle", () => {
    const { shots, warnings } = planShots({
      actions: [
        act("a", 1000, { x: 50, y: 50, width: 80, height: 30 }),
        act("b", 1300, { x: 1100, y: 700, width: 80, height: 30 }),
      ],
      focus: [],
      size,
      durationMs: 5000,
      tokens: camera,
    });
    expect(warnings.some((w) => w.includes("never settle"))).toBe(true);
    for (let i = 2; i < shots.length; i++)
      expect(shots[i].atMs - shots[i - 1].atMs).toBeGreaterThanOrEqual(camera.minShotMs);
  });

  it("holds still when the camera is disabled", () => {
    const { shots } = planShots({
      actions: [act("a", 1000, { x: 0, y: 0, width: 10, height: 10 })],
      focus: [],
      size,
      durationMs: 3000,
      tokens: { ...camera, enabled: false },
    });
    expect(shots).toEqual([expect.objectContaining({ camera: { x: 640, y: 400, zoom: 1 } })]);
  });

  it("keeps the fitted view inside the media", () => {
    const c = fitCamera({ x: 0, y: 0, width: 40, height: 40 }, size, camera);
    expect(c.zoom).toBe(camera.maxZoom);
    expect(c.x - size.width / c.zoom / 2).toBeGreaterThanOrEqual(0);
    expect(c.y - size.height / c.zoom / 2).toBeGreaterThanOrEqual(0);
  });
});

describe("camera track", () => {
  it("springs to each shot and never leaves the media", () => {
    const target = { x: 500, y: 300, zoom: 1.6 };
    const track = cameraTrack(
      [
        { atMs: 0, camera: { x: 640, y: 400, zoom: 1 }, target: null, reason: "", events: [] },
        { atMs: 500, camera: target, target: null, reason: "", events: [] },
      ],
      90,
      30,
      size,
      camera
    );
    expect(track[0]).toEqual({ x: 640, y: 400, zoom: 1 });
    expect(track[89].zoom).toBeCloseTo(1.6, 1);
    expect(track[89].x).toBeCloseTo(500, -1);
    for (const c of track) {
      expect(c.x - size.width / c.zoom / 2).toBeGreaterThanOrEqual(-1e-6);
      expect(c.y + size.height / c.zoom / 2).toBeLessThanOrEqual(size.height + 1e-6);
    }
  });
});

describe("cursor", () => {
  it("evaluates cubic-bezier easing", () => {
    expect(bezier(0, [0.77, 0, 0.175, 1])).toBe(0);
    expect(bezier(1, [0.77, 0, 0.175, 1])).toBe(1);
    expect(bezier(0.5, [0.25, 0.25, 0.75, 0.75])).toBeCloseTo(0.5, 3);
  });

  it("arrives on the target before the action and fades while results are read", () => {
    const actions = [
      act("a", 1000, { x: 100, y: 100, width: 100, height: 40 }),
      act("b", 3000, { x: 900, y: 600, width: 100, height: 40 }),
    ];
    const fps = 60;
    const track = pointerTrack(actions, 6 * fps, fps, size, cursor);
    const frameAt = (ms: number) => track[Math.round((ms * fps) / 1000)];
    expect(frameAt(0)).toBeNull();
    expect(frameAt(1000)).toMatchObject({ x: 150, y: 120 });
    expect(frameAt(3000)).toMatchObject({ x: 950, y: 620 });
    expect(frameAt(1050)!.scale).toBeLessThan(1);
    expect(frameAt(1050)!.rippleAgeMs).not.toBeNull();
    expect(frameAt(5900)).toBeNull();
  });

  it("shows touches only around taps", () => {
    const track = touchTrack(
      [act("t", 1000, { x: 100, y: 100, width: 40, height: 40 }, "tap")],
      90,
      30,
      cursor
    );
    expect(track[0]).toBeNull();
    expect(track[30]).toMatchObject({ x: 120, y: 120, pressed: 1 });
    expect(track[89]).toBeNull();
  });
});

describe("layout", () => {
  it("never stretches the source", () => {
    for (const frame of ["browser", "window", "device", "rounded", "none"] as const) {
      const layout = computeLayout(
        { width: 1920, height: 1080 },
        { width: 1280, height: 577 },
        frame
      );
      expect(layout.content.width / layout.content.height).toBeCloseTo(1280 / 577, 2);
      expect(layout.content.x).toBeGreaterThanOrEqual(0);
      expect(layout.content.y + layout.content.height).toBeLessThanOrEqual(1080);
    }
  });

  it("picks chrome by source", () => {
    expect(resolveFrame("auto", "browser", true)).toBe("browser");
    expect(resolveFrame("auto", "ios-simulator", true)).toBe("device");
    expect(resolveFrame("auto", "browser", false)).toBe("none");
  });
});
