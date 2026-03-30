import type { AgentEvent, AgentEventType, Rect } from "../types.js";

/**
 * MCP browser tool event as received from the tool relay.
 *
 * This is the shape that arrives when an agent requests a browser action
 * via the MCP tool protocol. The key challenge: tools use element reference
 * IDs (e.g. "@e5") not pixel coordinates. We need a resolver to map
 * refs → screen positions.
 */
export interface McpToolEvent {
  /** Tool method name (e.g. "browserClick", "browserType"). */
  method: string;
  /** Tool request ID. */
  requestId: string;
  /** Tool parameters. */
  params: Record<string, unknown>;
  /** Timestamp in session-relative milliseconds. If not provided, computed
   *  as elapsed time since adapter construction. Epoch timestamps (> 1e12)
   *  are auto-converted to relative by subtracting adapter start time. */
  timestamp?: number;
}

/**
 * Resolved element position from an element reference.
 * This is what you get back after querying the browser for an element's rect.
 */
export interface ResolvedElement {
  /** Center X in page coordinates. */
  x: number;
  /** Center Y in page coordinates. */
  y: number;
  /** Element bounding rect. */
  rect: Rect;
}

/**
 * Callback to resolve an element reference to screen coordinates.
 *
 * Implementations:
 * - Electron BrowserView: `eval_browser_webview` to query element rect via ref
 * - CDP: `DOM.getBoxModel` or `Runtime.evaluate` to get element position
 * - VNC: Track cursor position from VNC protocol events
 * - Fallback: Use last known position + heuristic offset
 */
export type ElementResolver = (
  ref: string,
  method: string,
) => Promise<ResolvedElement | null>;

/**
 * Maps MCP browser tool events to camera engine AgentEvents.
 *
 * The adapter sits between the tool relay and the camera engine.
 * When a tool.request fires, it resolves element positions and
 * produces the AgentEvent the camera engine needs.
 *
 * Usage:
 * ```ts
 * const adapter = new McpToolAdapter(resolveElement);
 *
 * // When tool.request arrives from WebSocket:
 * const agentEvent = await adapter.adapt(toolEvent);
 * if (agentEvent) {
 *   cameraEngine.pushEvent(agentEvent);
 * }
 * ```
 */
export class McpToolAdapter {
  private resolver: ElementResolver;
  private sourceCenter: { x: number; y: number };
  private lastKnownPosition: { x: number; y: number };
  private startTime: number;

  constructor(resolver: ElementResolver, sourceSize = { width: 1920, height: 1080 }) {
    this.resolver = resolver;
    this.sourceCenter = { x: sourceSize.width / 2, y: sourceSize.height / 2 };
    this.lastKnownPosition = { ...this.sourceCenter };
    this.startTime = Date.now();
  }

  /**
   * Convert an MCP tool event to a camera AgentEvent.
   *
   * Returns null for events that don't affect the camera
   * (e.g. console messages, network requests).
   */
  async adapt(event: McpToolEvent): Promise<AgentEvent | null> {
    const mapping = METHOD_MAP[event.method];
    if (!mapping) return null;

    // Normalize timestamp to session-relative ms.
    // Auto-detect epoch timestamps (> 1e12) and convert to relative.
    let t: number;
    if (event.timestamp != null) {
      t = event.timestamp > 1e12 ? event.timestamp - this.startTime : event.timestamp;
    } else {
      t = Date.now() - this.startTime;
    }
    const ref = this.extractRef(event.params);

    // Resolve element position
    let position = this.lastKnownPosition;
    let elementRect: Rect | undefined;

    if (ref) {
      try {
        const resolved = await this.resolver(ref, event.method);
        if (resolved) {
          position = { x: resolved.x, y: resolved.y };
          elementRect = resolved.rect;
          this.lastKnownPosition = position;
        }
      } catch {
        // Resolver failed — fall back to lastKnownPosition (already set above)
      }
    } else if (event.method === "browserNavigate" || event.method === "browserNavigateBack") {
      // Navigation: reset to viewport center
      position = { ...this.sourceCenter };
      this.lastKnownPosition = position;
    }

    return {
      type: mapping.type,
      t,
      x: position.x,
      y: position.y,
      elementRect,
      meta: this.extractMeta(event),
    };
  }

  /**
   * Adapt multiple tool events from a session replay.
   * Useful for post-processing a recorded session.
   */
  async adaptBatch(events: McpToolEvent[]): Promise<AgentEvent[]> {
    const results: AgentEvent[] = [];
    for (const event of events) {
      const adapted = await this.adapt(event);
      if (adapted) results.push(adapted);
    }
    return results;
  }

  /**
   * Create an AgentEvent directly from known coordinates.
   * Use when you already have x/y (e.g. from visual-effects cursor position).
   */
  static fromCoordinates(
    method: string,
    x: number,
    y: number,
    t: number,
    elementRect?: Rect,
  ): AgentEvent | null {
    const mapping = METHOD_MAP[method];
    if (!mapping) return null;

    return {
      type: mapping.type,
      t,
      x,
      y,
      elementRect,
    };
  }

  private extractRef(params: Record<string, unknown>): string | null {
    if (typeof params.ref === "string") return params.ref;
    if (typeof params.element === "string") return params.element;
    return null;
  }

  private extractMeta(event: McpToolEvent): Record<string, unknown> {
    const meta: Record<string, unknown> = { method: event.method };

    if (event.params.text) meta.text = event.params.text;
    if (event.params.url) meta.url = event.params.url;
    if (event.params.key) meta.key = event.params.key;
    if (event.params.direction) meta.direction = event.params.direction;

    return meta;
  }
}

/** Maps MCP method names to AgentEvent types. */
const METHOD_MAP: Record<string, { type: AgentEventType }> = {
  browserClick: { type: "click" },
  browserType: { type: "type" },
  browserNavigate: { type: "navigate" },
  browserScroll: { type: "scroll" },
  browserScreenshot: { type: "screenshot" },
  browserPressKey: { type: "type" },
  browserHover: { type: "click" },
  browserSelectOption: { type: "click" },
  browserNavigateBack: { type: "navigate" },
  browserEvaluate: { type: "idle" },
  browserWaitFor: { type: "idle" },
  // Not mapped (no visual effect):
  // browserSnapshot, browserConsoleMessages, browserNetworkRequests
};

/**
 * JavaScript snippet to resolve an element ref to its bounding rect.
 *
 * Usage: evaluate `RESOLVE_ELEMENT_JS + '("@e5")'` in the browser page
 * via `eval_browser_webview` or CDP `Runtime.evaluate`.
 *
 * Returns `{ x, y, rect }` where x/y is the element center, or null if not found.
 *
 * Compatible with agent-browser's ref system (@e1, @e2, etc.)
 * which assigns `data-deus-ref` attributes during snapshot.
 *
 * The ref argument is sanitized inside the IIFE to strip `"`, `\`, and `]`
 * characters before building the CSS selector. This is defense-in-depth —
 * refs are always `@eN` format, but it hardens against selector injection.
 *
 * Example:
 *   const js = RESOLVE_ELEMENT_JS + '("@e5")';
 *   const result = await page.evaluate(js); // { x: 500, y: 300, rect: {...} }
 */
export const RESOLVE_ELEMENT_JS = `
(function(ref) {
  var safe = String(ref).replace(/["\\\\\\]]/g, '');
  var selector = '[data-deus-ref="' + safe + '"]';
  var el = document.querySelector(selector);

  if (!el) {
    var num = safe.replace('@e', '');
    var all = document.querySelectorAll('[data-playwright-ref="' + num + '"]');
    if (all.length) el = all[0];
  }

  if (!el) return null;

  var rect = el.getBoundingClientRect();
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
  };
})
`;
