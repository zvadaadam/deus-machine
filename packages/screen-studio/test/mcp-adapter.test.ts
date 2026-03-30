import { describe, it, expect, vi } from "vitest";
import { McpToolAdapter, RESOLVE_ELEMENT_JS, type ElementResolver, type McpToolEvent } from "../src/adapter/mcp-adapter.js";

describe("McpToolAdapter", () => {
  const mockResolver: ElementResolver = vi.fn(async (ref) => {
    // Simulate resolving element refs to positions
    const positions: Record<string, { x: number; y: number; rect: { x: number; y: number; width: number; height: number } }> = {
      "@e1": { x: 500, y: 300, rect: { x: 400, y: 280, width: 200, height: 40 } },
      "@e5": { x: 800, y: 450, rect: { x: 750, y: 430, width: 100, height: 40 } },
      "@e10": { x: 200, y: 600, rect: { x: 100, y: 580, width: 200, height: 40 } },
    };
    return positions[ref] ?? null;
  });

  it("adapts browserClick to click event with resolved position", async () => {
    const adapter = new McpToolAdapter(mockResolver);
    const event: McpToolEvent = {
      method: "browserClick",
      requestId: "req1",
      params: { ref: "@e5" },
      timestamp: 1000,
    };

    const result = await adapter.adapt(event);

    expect(result).not.toBeNull();
    expect(result!.type).toBe("click");
    expect(result!.x).toBe(800);
    expect(result!.y).toBe(450);
    expect(result!.elementRect).toEqual({ x: 750, y: 430, width: 100, height: 40 });
    expect(result!.t).toBe(1000);
  });

  it("adapts browserType to type event", async () => {
    const adapter = new McpToolAdapter(mockResolver);
    const event: McpToolEvent = {
      method: "browserType",
      requestId: "req2",
      params: { ref: "@e1", text: "hello world" },
      timestamp: 2000,
    };

    const result = await adapter.adapt(event);

    expect(result!.type).toBe("type");
    expect(result!.x).toBe(500);
    expect(result!.y).toBe(300);
    expect(result!.meta?.text).toBe("hello world");
  });

  it("adapts browserNavigate to navigate event", async () => {
    const adapter = new McpToolAdapter(mockResolver);
    const event: McpToolEvent = {
      method: "browserNavigate",
      requestId: "req3",
      params: { url: "https://example.com" },
      timestamp: 3000,
    };

    const result = await adapter.adapt(event);

    expect(result!.type).toBe("navigate");
    expect(result!.meta?.url).toBe("https://example.com");
    // Navigate with no ref uses center position
    expect(result!.x).toBe(960);
    expect(result!.y).toBe(540);
  });

  it("adapts browserScroll to scroll event", async () => {
    const adapter = new McpToolAdapter(mockResolver);
    const event: McpToolEvent = {
      method: "browserScroll",
      requestId: "req4",
      params: { direction: "down", amount: 300 },
      timestamp: 4000,
    };

    const result = await adapter.adapt(event);

    expect(result!.type).toBe("scroll");
    expect(result!.meta?.direction).toBe("down");
  });

  it("returns null for non-visual events (snapshot)", async () => {
    const adapter = new McpToolAdapter(mockResolver);
    const event: McpToolEvent = {
      method: "browserSnapshot",
      requestId: "req5",
      params: {},
      timestamp: 5000,
    };

    const result = await adapter.adapt(event);
    expect(result).toBeNull();
  });

  it("returns null for console messages", async () => {
    const adapter = new McpToolAdapter(mockResolver);
    const event: McpToolEvent = {
      method: "browserConsoleMessages",
      requestId: "req6",
      params: {},
    };

    const result = await adapter.adapt(event);
    expect(result).toBeNull();
  });

  it("uses last known position when resolver returns null", async () => {
    const failResolver: ElementResolver = vi.fn(async () => null);
    const adapter = new McpToolAdapter(failResolver);

    // First event with successful resolve won't happen, so uses default
    const event: McpToolEvent = {
      method: "browserClick",
      requestId: "req7",
      params: { ref: "@unknown" },
      timestamp: 1000,
    };

    const result = await adapter.adapt(event);
    // Falls back to default center position (960, 540)
    expect(result!.x).toBe(960);
    expect(result!.y).toBe(540);
  });

  it("remembers last resolved position as fallback", async () => {
    const adapter = new McpToolAdapter(mockResolver);

    // First: resolve @e5 successfully
    await adapter.adapt({
      method: "browserClick",
      requestId: "r1",
      params: { ref: "@e5" },
      timestamp: 1000,
    });

    // Second: resolve unknown ref → should use @e5's position
    const onceResolver: ElementResolver = vi.fn(async () => null);
    // Can't swap resolver, but the adapter caches lastKnownPosition
    // from the first successful resolve

    const event: McpToolEvent = {
      method: "browserClick",
      requestId: "r2",
      params: { ref: "@unknown" },
      timestamp: 2000,
    };

    // Since we can't swap the resolver, test via adaptBatch
    // The adapter internally cached (800, 450) from @e5
    const result = await adapter.adapt(event);
    // @unknown resolves to null via mockResolver, so uses last known (800, 450)
    // Actually mockResolver returns null for @unknown, so it uses lastKnownPosition
    expect(result!.x).toBe(800);
    expect(result!.y).toBe(450);
  });

  it("adaptBatch processes multiple events", async () => {
    const adapter = new McpToolAdapter(mockResolver);
    const events: McpToolEvent[] = [
      { method: "browserClick", requestId: "r1", params: { ref: "@e1" }, timestamp: 0 },
      { method: "browserType", requestId: "r2", params: { ref: "@e1", text: "hi" }, timestamp: 500 },
      { method: "browserSnapshot", requestId: "r3", params: {}, timestamp: 1000 }, // skipped
      { method: "browserScroll", requestId: "r4", params: { direction: "down" }, timestamp: 1500 },
    ];

    const results = await adapter.adaptBatch(events);

    // Snapshot should be filtered out
    expect(results).toHaveLength(3);
    expect(results[0].type).toBe("click");
    expect(results[1].type).toBe("type");
    expect(results[2].type).toBe("scroll");
  });

  describe("RESOLVE_ELEMENT_JS", () => {
    it("contains ref sanitization to prevent selector injection", () => {
      // The IIFE should sanitize the ref by stripping ", \, and ] characters
      // In the template literal the regex appears as: /["\]]/g
      expect(RESOLVE_ELEMENT_JS).toContain("String(ref).replace(");
      expect(RESOLVE_ELEMENT_JS).toContain(", '')");
    });

    it("uses sanitized ref in both selector lookups", () => {
      // Both data-deus-ref and data-playwright-ref selectors should use 'safe', not 'ref'
      expect(RESOLVE_ELEMENT_JS).toContain("'[data-deus-ref=\"' + safe + '\"");
      expect(RESOLVE_ELEMENT_JS).toContain("safe.replace('@e', '')");
    });
  });

  describe("fromCoordinates (static)", () => {
    it("creates event directly from x/y", () => {
      const event = McpToolAdapter.fromCoordinates("browserClick", 500, 300, 1000);

      expect(event).not.toBeNull();
      expect(event!.type).toBe("click");
      expect(event!.x).toBe(500);
      expect(event!.y).toBe(300);
      expect(event!.t).toBe(1000);
    });

    it("returns null for unmapped methods", () => {
      const event = McpToolAdapter.fromCoordinates("browserSnapshot", 0, 0, 0);
      expect(event).toBeNull();
    });

    it("includes element rect when provided", () => {
      const rect = { x: 400, y: 280, width: 200, height: 40 };
      const event = McpToolAdapter.fromCoordinates("browserType", 500, 300, 0, rect);

      expect(event!.elementRect).toEqual(rect);
    });
  });
});
