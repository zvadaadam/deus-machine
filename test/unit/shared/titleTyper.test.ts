import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnimatedTitle } from "@/components/ui/animated-title";
import { tempo } from "@/shared/lib/tempo";
import {
  createTitleTyper,
  type TitleTyperClock,
  type TitleTyperFrame,
} from "@/shared/lib/titleTyper";

const BACKSPACE_MS = tempo.moderate.exit.duration * 1000;
const PAUSE_MS = tempo.step * 1000;
const TYPE_MS = tempo.slow.duration * 1000;

function visibleText(frame: TitleTyperFrame): string {
  return frame.solid + frame.tail.map((item) => item.char).join("");
}

function createFakeClock(): TitleTyperClock {
  let nextId = 1;
  const handles = new Map<number, ReturnType<typeof setTimeout>>();
  return {
    now: () => Date.now(),
    request: (cb) => {
      const id = nextId++;
      const handle = setTimeout(() => {
        handles.delete(id);
        cb();
      }, 16);
      handles.set(id, handle);
      return id;
    },
    cancel: (id) => {
      const handle = handles.get(id);
      if (handle) {
        clearTimeout(handle);
        handles.delete(id);
      }
    },
  };
}

describe("createTitleTyper", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips animation on initial mount", () => {
    const frames: TitleTyperFrame[] = [];
    const typer = createTitleTyper(
      { entityId: "w1", text: "New chat" },
      (frame) => frames.push(frame),
      createFakeClock()
    );

    vi.advanceTimersByTime(1000);

    expect(frames).toEqual([]);
    expect(typer.getFrame()).toEqual({
      entityId: "w1",
      target: "New chat",
      solid: "New chat",
      tail: [],
      reserve: [],
    });
    typer.dispose();
  });

  it("peels away old text, pauses, fades in new text, and settles within tempo tiers", () => {
    const events: Array<{ at: number; frame: TitleTyperFrame }> = [];
    const typer = createTitleTyper(
      { entityId: "w1", text: "Old workspace title" },
      (frame) => events.push({ at: Date.now(), frame }),
      createFakeClock()
    );

    typer.set("w1", "Fix OAuth redirect flow", false);
    vi.advanceTimersByTime(1000);

    const displays = events.map((e) => visibleText(e.frame));
    const minLenIndex = displays.reduce(
      (best, val, idx, arr) => (val.length < arr[best].length ? idx : best),
      0
    );

    expect(displays[minLenIndex]).toBe("");
    const shrinkPhase = events.slice(0, minLenIndex + 1);
    const growPhase = events.slice(minLenIndex);

    for (let i = 1; i < shrinkPhase.length; i++) {
      expect(visibleText(shrinkPhase[i].frame).length).toBeLessThanOrEqual(
        visibleText(shrinkPhase[i - 1].frame).length
      );
    }
    for (let i = 1; i < growPhase.length; i++) {
      expect(visibleText(growPhase[i].frame).length).toBeGreaterThanOrEqual(
        visibleText(growPhase[i - 1].frame).length
      );
    }

    expect(shrinkPhase.some((e) => e.frame.tail.some((c) => c.opacity > 0 && c.opacity < 1))).toBe(
      true
    );
    expect(growPhase.some((e) => e.frame.tail.some((c) => c.opacity > 0 && c.opacity < 1))).toBe(
      true
    );

    expect(events[0].frame.reserve).toEqual(["Old workspace title", "Fix OAuth redirect flow"]);

    const settled = events[events.length - 1];
    expect(settled.frame).toEqual({
      entityId: "w1",
      target: "Fix OAuth redirect flow",
      solid: "Fix OAuth redirect flow",
      tail: [],
      reserve: [],
    });

    expect(settled.at).toBeLessThanOrEqual(BACKSPACE_MS + PAUSE_MS + TYPE_MS + 16);
    typer.dispose();
  });

  it("keeps shared word prefixes and clears divergent prefixes without a space", () => {
    const wordFrames: TitleTyperFrame[] = [];
    const wordTyper = createTitleTyper(
      { entityId: "w1", text: "Fix login bug" },
      (frame) => wordFrames.push(frame),
      createFakeClock()
    );
    wordTyper.set("w1", "Fix layout bug", false);
    vi.advanceTimersByTime(1000);

    expect(wordFrames.every((f) => visibleText(f).startsWith("Fix "))).toBe(true);
    expect(wordTyper.getFrame().solid).toBe("Fix layout bug");
    wordTyper.dispose();

    const clearFrames: TitleTyperFrame[] = [];
    const clearTyper = createTitleTyper(
      { entityId: "w2", text: "Refactor" },
      (frame) => clearFrames.push(frame),
      createFakeClock()
    );
    clearTyper.set("w2", "Refresh", false);
    vi.advanceTimersByTime(1000);

    expect(clearFrames.some((f) => visibleText(f) === "")).toBe(true);
    expect(clearTyper.getFrame().solid).toBe("Refresh");
    clearTyper.dispose();
  });

  it("handles append-only, delete-only, and long titles within tempo bounds", () => {
    const appendEvents: Array<{ at: number; frame: TitleTyperFrame }> = [];
    const appendTyper = createTitleTyper(
      { entityId: "w1", text: "Auth" },
      (frame) => appendEvents.push({ at: Date.now(), frame }),
      createFakeClock()
    );
    appendTyper.set("w1", "Auth flow", false);
    vi.advanceTimersByTime(1000);

    expect(appendEvents.every((e) => visibleText(e.frame).startsWith("Auth"))).toBe(true);
    expect(appendEvents[appendEvents.length - 1].at).toBeLessThanOrEqual(TYPE_MS + 16);
    expect(appendTyper.getFrame().solid).toBe("Auth flow");
    appendTyper.dispose();

    vi.setSystemTime(0);
    const deleteEvents: Array<{ at: number; frame: TitleTyperFrame }> = [];
    const deleteTyper = createTitleTyper(
      { entityId: "w2", text: "Auth flow" },
      (frame) => deleteEvents.push({ at: Date.now(), frame }),
      createFakeClock()
    );
    deleteTyper.set("w2", "Auth", false);
    vi.advanceTimersByTime(1000);

    expect(deleteEvents.every((e) => visibleText(e.frame).startsWith("Auth"))).toBe(true);
    expect(deleteEvents[deleteEvents.length - 1].at).toBeLessThanOrEqual(BACKSPACE_MS + 16);
    expect(deleteTyper.getFrame().solid).toBe("Auth");
    deleteTyper.dispose();

    vi.setSystemTime(0);
    const longEvents: Array<{ at: number; frame: TitleTyperFrame }> = [];
    const longTyper = createTitleTyper(
      { entityId: "l", text: "A".repeat(80) },
      (frame) => longEvents.push({ at: Date.now(), frame }),
      createFakeClock()
    );
    longTyper.set("l", "B".repeat(80), false);
    vi.advanceTimersByTime(1000);

    const longEnd = longEvents[longEvents.length - 1];
    expect(longEnd.frame.solid).toBe("B".repeat(80));
    expect(longEnd.at).toBeLessThanOrEqual(BACKSPACE_MS + PAUSE_MS + TYPE_MS + 16);
    longTyper.dispose();
  });

  it("snaps immediately when entityId changes", () => {
    const frames: TitleTyperFrame[] = [];
    const typer = createTitleTyper(
      { entityId: "w1", text: "Alpha" },
      (frame) => frames.push(frame),
      createFakeClock()
    );

    typer.set("w1", "Beta", false);
    vi.advanceTimersByTime(48);
    expect(typer.getFrame().reserve.length).toBeGreaterThan(0);

    const countBefore = frames.length;
    typer.set("w2", "Gamma", false);
    vi.advanceTimersByTime(500);

    expect(frames.length).toBe(countBefore + 1);
    expect(typer.getFrame()).toEqual({
      entityId: "w2",
      target: "Gamma",
      solid: "Gamma",
      tail: [],
      reserve: [],
    });
    typer.dispose();
  });

  it("restarts mid-flight from frame.solid without flashing partly faded tail characters", () => {
    const frames: TitleTyperFrame[] = [];
    const typer = createTitleTyper(
      { entityId: "w1", text: "Fix login bug" },
      (frame) => frames.push(frame),
      createFakeClock()
    );

    typer.set("w1", "Fix oauth redirect", false);
    vi.advanceTimersByTime(220);

    const midFrame = typer.getFrame();
    expect(midFrame.tail.length).toBeGreaterThan(0);
    expect(midFrame.solid.startsWith("Fix ")).toBe(true);

    const framesBeforeInterrupt = frames.length;
    typer.set("w1", "Fix session refresh", false);

    // Restarts from `midFrame.solid` (not `midFrame.solid + tail`), so faded tail doesn't flash to 1.
    expect(frames[framesBeforeInterrupt]).toEqual({
      entityId: "w1",
      target: "Fix session refresh",
      solid: midFrame.solid,
      tail: [],
      reserve: [midFrame.solid, "Fix session refresh"],
    });

    vi.advanceTimersByTime(1000);
    const postInterrupt = frames.slice(framesBeforeInterrupt);
    expect(postInterrupt.every((f) => visibleText(f).startsWith("Fix "))).toBe(true);
    expect(typer.getFrame()).toEqual({
      entityId: "w1",
      target: "Fix session refresh",
      solid: "Fix session refresh",
      tail: [],
      reserve: [],
    });
    typer.dispose();
  });

  it("snaps immediately under reduced motion, including when toggled mid-flight", () => {
    const frames: TitleTyperFrame[] = [];
    const typer = createTitleTyper(
      { entityId: "w1", text: "Alpha" },
      (frame) => frames.push(frame),
      createFakeClock()
    );

    typer.set("w1", "Beta", true);
    vi.advanceTimersByTime(1000);

    expect(frames).toEqual([
      {
        entityId: "w1",
        target: "Beta",
        solid: "Beta",
        tail: [],
        reserve: [],
      },
    ]);

    // Turning reduced motion off allows subsequent renames to animate, and turning it
    // back on mid-flight immediately snaps to the target and cancels remaining frames.
    typer.set("w1", "Gamma delta", false);
    vi.advanceTimersByTime(64);
    expect(typer.getFrame().reserve.length).toBeGreaterThan(0);

    const beforeToggle = frames.length;
    typer.set("w1", "Gamma delta", true);
    vi.advanceTimersByTime(1000);

    expect(frames.length).toBe(beforeToggle + 1);
    expect(typer.getFrame()).toEqual({
      entityId: "w1",
      target: "Gamma delta",
      solid: "Gamma delta",
      tail: [],
      reserve: [],
    });
    typer.dispose();
  });

  it("never splits surrogate pairs when animating emoji titles", () => {
    const frames: TitleTyperFrame[] = [];
    const typer = createTitleTyper(
      { entityId: "w1", text: "🚀 Launch" },
      (frame) => frames.push(frame),
      createFakeClock()
    );

    typer.set("w1", "✨ Polish", false);
    vi.advanceTimersByTime(1000);

    for (const frame of frames) {
      expect(visibleText(frame)).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
      );
    }
    expect(typer.getFrame().solid).toBe("✨ Polish");
    typer.dispose();
  });

  it("stops emitting after dispose()", () => {
    const frames: TitleTyperFrame[] = [];
    const typer = createTitleTyper(
      { entityId: "w1", text: "Alpha" },
      (frame) => frames.push(frame),
      createFakeClock()
    );

    typer.set("w1", "Beta", false);
    const countAfterStart = frames.length;
    typer.dispose();
    vi.advanceTimersByTime(1000);

    expect(frames.length).toBe(countAfterStart);
  });
});

describe("AnimatedTitle", () => {
  it("renders plain text at rest with no extra DOM or SSR warnings", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const html = renderToStaticMarkup(
        createElement(AnimatedTitle, { text: "Orbit", entityId: "w1" })
      );
      expect(html).toBe("Orbit");
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("subscribes to live prefers-reduced-motion changes on mounted titles", () => {
    let matches = false;
    const listeners = new Set<() => void>();
    const originalWindow = globalThis.window;

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        matchMedia: (query: string) => {
          expect(query).toBe("(prefers-reduced-motion: reduce)");
          return {
            get matches() {
              return matches;
            },
            addEventListener: (event: string, listener: () => void) => {
              if (event === "change") listeners.add(listener);
            },
            removeEventListener: (event: string, listener: () => void) => {
              if (event === "change") listeners.delete(listener);
            },
          };
        },
      },
    });

    const spy = vi.spyOn(React, "useSyncExternalStore");
    try {
      renderToStaticMarkup(createElement(AnimatedTitle, { text: "Orbit", entityId: "w1" }));
      expect(spy).toHaveBeenCalledTimes(1);

      const [subscribe, getSnapshot, getServerSnapshot] = spy.mock.calls[0];
      expect(getServerSnapshot?.()).toBe(false);
      expect(getSnapshot()).toBe(false);

      const onChange = vi.fn();
      const unsubscribe = subscribe(onChange);
      expect(listeners.size).toBe(1);

      // Simulate OS toggling reduced motion on while the title is mounted.
      matches = true;
      for (const listener of listeners) listener();
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(getSnapshot()).toBe(true);

      // Simulate toggling reduced motion back off.
      matches = false;
      for (const listener of listeners) listener();
      expect(onChange).toHaveBeenCalledTimes(2);
      expect(getSnapshot()).toBe(false);

      unsubscribe();
      expect(listeners.size).toBe(0);
    } finally {
      spy.mockRestore();
      if (originalWindow === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
      }
    }
  });
});
