import { describe, it, expect } from "vitest";
import { IntentClassifier } from "../src/intent/classifier.js";
import type { AgentEvent } from "../src/types.js";

describe("IntentClassifier", () => {
  const classifier = new IntentClassifier({
    sourceSize: { width: 1920, height: 1080 },
  });

  it("classifies a single click event", () => {
    const events: AgentEvent[] = [
      { type: "click", x: 500, y: 300, t: 0 },
    ];

    const intents = classifier.classify(events);
    expect(intents).toHaveLength(1);
    expect(intents[0].type).toBe("clicking");
    expect(intents[0].center.x).toBe(500);
    expect(intents[0].center.y).toBe(300);
  });

  it("classifies typing events", () => {
    const events: AgentEvent[] = [
      { type: "click", x: 500, y: 300, t: 0 },
      { type: "type", x: 500, y: 300, t: 100 },
      { type: "type", x: 520, y: 300, t: 200 },
      { type: "type", x: 540, y: 300, t: 300 },
    ];

    const intents = classifier.classify(events);
    expect(intents).toHaveLength(1);
    expect(intents[0].type).toBe("typing"); // typing dominates when mixed with click
  });

  it("separates events by temporal gap", () => {
    const events: AgentEvent[] = [
      { type: "click", x: 100, y: 100, t: 0 },
      { type: "click", x: 110, y: 100, t: 100 },
      // Large gap
      { type: "click", x: 800, y: 500, t: 5000 },
    ];

    const intents = classifier.classify(events);
    expect(intents).toHaveLength(2);
    // First group centered around x=100, second around x=800
    expect(intents[0].center.x).toBeLessThan(200);
    expect(intents[1].center.x).toBeGreaterThan(700);
  });

  it("separates events by spatial distance", () => {
    const events: AgentEvent[] = [
      { type: "click", x: 100, y: 100, t: 0 },
      { type: "click", x: 1800, y: 900, t: 500 }, // far away
    ];

    const intents = classifier.classify(events);
    expect(intents).toHaveLength(2);
  });

  it("groups nearby click events together", () => {
    const events: AgentEvent[] = [
      { type: "click", x: 500, y: 300, t: 0 },
      { type: "click", x: 510, y: 305, t: 500 },
      { type: "click", x: 520, y: 310, t: 1000 },
    ];

    const intents = classifier.classify(events);
    expect(intents).toHaveLength(1);
    expect(intents[0].type).toBe("clicking");
  });

  it("classifies scroll events", () => {
    const events: AgentEvent[] = [
      { type: "scroll", x: 500, y: 300, t: 0 },
      { type: "scroll", x: 500, y: 400, t: 200 },
    ];

    const intents = classifier.classify(events);
    expect(intents).toHaveLength(1);
    expect(intents[0].type).toBe("scrolling");
  });

  it("classifies navigation events", () => {
    const events: AgentEvent[] = [
      { type: "navigate", x: 500, y: 300, t: 0 },
    ];

    const intents = classifier.classify(events);
    expect(intents).toHaveLength(1);
    expect(intents[0].type).toBe("navigating");
  });

  it("handles empty event array", () => {
    const intents = classifier.classify([]);
    expect(intents).toHaveLength(0);
  });

  it("computes bounds from element rects when available", () => {
    const events: AgentEvent[] = [
      {
        type: "click",
        x: 500,
        y: 300,
        t: 0,
        elementRect: { x: 480, y: 280, width: 200, height: 50 },
      },
    ];

    const intents = classifier.classify(events);
    expect(intents[0].bounds).toBeDefined();
    expect(intents[0].bounds!.width).toBeGreaterThan(200);
  });

  describe("classifyIncremental", () => {
    it("creates new intent for first event", () => {
      const event: AgentEvent = { type: "click", x: 500, y: 300, t: 0 };
      const intent = classifier.classifyIncremental(event, null);

      expect(intent.type).toBe("clicking");
      expect(intent.center.x).toBe(500);
    });

    it("extends existing intent for compatible event", () => {
      const intent = {
        type: "clicking" as const,
        startT: 0,
        endT: 100,
        center: { x: 500, y: 300 },
        zoom: 1,
        bounds: { x: 450, y: 250, width: 100, height: 100 },
      };

      const event: AgentEvent = { type: "click", x: 520, y: 310, t: 500 };
      const updated = classifier.classifyIncremental(event, intent);

      expect(updated.type).toBe("clicking");
      expect(updated.endT).toBe(500);
      // Center should have moved toward the new event
      expect(updated.center.x).toBeGreaterThan(500);
    });

    it("creates new intent for incompatible event", () => {
      const intent = {
        type: "clicking" as const,
        startT: 0,
        endT: 100,
        center: { x: 100, y: 100 },
        zoom: 1,
      };

      // Far away scroll event
      const event: AgentEvent = { type: "scroll", x: 1800, y: 900, t: 5000 };
      const newIntent = classifier.classifyIncremental(event, intent);

      expect(newIntent.type).toBe("scrolling");
      expect(newIntent.startT).toBe(5000);
    });
  });
});
