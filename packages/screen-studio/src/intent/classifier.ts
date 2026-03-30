import type { AgentEvent, Intent, IntentType, Point, Rect, Size } from "../types.js";

/**
 * Configuration for the intent classifier.
 */
export interface ClassifierConfig {
  /** Source content size (for normalizing distances). */
  sourceSize: Size;
  /** Max time gap (ms) between events to group into same intent. */
  groupingGap: number;
  /** Max spatial distance (normalized 0-1) to group events. */
  groupingRadius: number;
  /** Time threshold (ms) for idle detection. */
  idleThreshold: number;
}

const DEFAULT_CONFIG: ClassifierConfig = {
  sourceSize: { width: 1920, height: 1080 },
  groupingGap: 2000,
  groupingRadius: 0.3,
  idleThreshold: 3000,
};

/**
 * Classifies a stream of agent events into semantic intents.
 *
 * Each intent represents a contiguous segment of agent activity
 * (typing, clicking, scrolling, etc.) with a computed center point
 * and zoom level. The camera engine uses intents to determine
 * where to point and how much to zoom.
 *
 * Based on Screenize's IntentClassifier:
 * - Typing: keystrokes grouped within temporal windows
 * - Clicking: clicks grouped by temporal + spatial proximity
 * - Scrolling: scroll events merged within gaps
 * - Dragging: drag events with anticipation offset
 * - Navigating: page navigation events
 * - Idle: gaps longer than threshold
 */
export class IntentClassifier {
  private config: ClassifierConfig;

  constructor(config: Partial<ClassifierConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Classify a batch of events into intents.
   * Events must be sorted by timestamp.
   */
  classify(events: AgentEvent[]): Intent[] {
    if (events.length === 0) return [];

    const groups = this.groupEvents(events);
    return groups.map((group) => this.groupToIntent(group));
  }

  /**
   * Classify a single event in a streaming context.
   * Returns the current intent (may update an existing one or create new).
   */
  classifyIncremental(
    event: AgentEvent,
    currentIntent: Intent | null,
  ): Intent {
    if (!currentIntent || !this.canMerge(currentIntent, event)) {
      return this.eventToIntent(event);
    }

    // Extend current intent
    return {
      ...currentIntent,
      endT: event.t,
      center: this.updateCenter(currentIntent, event),
      bounds: this.expandBounds(currentIntent.bounds, event),
    };
  }

  /**
   * Group events by temporal and spatial proximity.
   */
  private groupEvents(events: AgentEvent[]): AgentEvent[][] {
    const groups: AgentEvent[][] = [];
    let currentGroup: AgentEvent[] = [events[0]];

    for (let i = 1; i < events.length; i++) {
      const prev = events[i - 1];
      const curr = events[i];

      if (this.shouldGroup(prev, curr)) {
        currentGroup.push(curr);
      } else {
        groups.push(currentGroup);
        currentGroup = [curr];
      }
    }
    groups.push(currentGroup);

    return groups;
  }

  /**
   * Determine if two consecutive events should be grouped.
   */
  private shouldGroup(a: AgentEvent, b: AgentEvent): boolean {
    // Different types generally don't group (except related types)
    if (!this.typesCompatible(a.type, b.type)) return false;

    // Time gap check
    if (b.t - a.t > this.config.groupingGap) return false;

    // Spatial distance check (normalized)
    const dx = (b.x - a.x) / this.config.sourceSize.width;
    const dy = (b.y - a.y) / this.config.sourceSize.height;
    const dist = Math.sqrt(dx * dx + dy * dy);

    return dist < this.config.groupingRadius;
  }

  private typesCompatible(a: AgentEvent["type"], b: AgentEvent["type"]): boolean {
    // Typing events always group with each other
    if (a === "type" && b === "type") return true;
    // Click + type can group (clicking a field then typing)
    if ((a === "click" && b === "type") || (a === "type" && b === "click")) return true;
    // Same type always groups
    return a === b;
  }

  private canMerge(intent: Intent, event: AgentEvent): boolean {
    const intentType = this.eventTypeToIntentType(event.type);

    // Compatible intent types
    const clickTypePair =
      (intent.type === "clicking" && intentType === "typing") ||
      (intent.type === "typing" && intentType === "clicking");
    if (intent.type !== intentType && !clickTypePair) {
      return false;
    }

    // Time gap
    if (event.t - intent.endT > this.config.groupingGap) return false;

    // Spatial distance
    const dx = (event.x - intent.center.x) / this.config.sourceSize.width;
    const dy = (event.y - intent.center.y) / this.config.sourceSize.height;
    const dist = Math.sqrt(dx * dx + dy * dy);

    return dist < this.config.groupingRadius;
  }

  /**
   * Convert a group of events into a single intent.
   */
  private groupToIntent(group: AgentEvent[]): Intent {
    const first = group[0];
    const last = group[group.length - 1];
    const intentType = this.resolveGroupType(group);
    const bounds = this.computeBounds(group);
    const center = this.computeCenter(group, bounds);

    return {
      type: intentType,
      startT: first.t,
      endT: last.t,
      center,
      zoom: 1, // Shot planner fills this in
      bounds,
    };
  }

  private eventToIntent(event: AgentEvent): Intent {
    return {
      type: this.eventTypeToIntentType(event.type),
      startT: event.t,
      endT: event.t,
      center: { x: event.x, y: event.y },
      zoom: 1,
      bounds: event.elementRect ?? {
        x: event.x - 50,
        y: event.y - 50,
        width: 100,
        height: 100,
      },
    };
  }

  private resolveGroupType(group: AgentEvent[]): IntentType {
    // Count event types in the group
    const counts = new Map<AgentEvent["type"], number>();
    for (const e of group) {
      counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
    }

    // Majority wins, with priority for typing
    if ((counts.get("type") ?? 0) > 0) return "typing";
    if ((counts.get("scroll") ?? 0) > 0) return "scrolling";
    if ((counts.get("drag") ?? 0) > 0) return "dragging";
    if ((counts.get("navigate") ?? 0) > 0) return "navigating";
    if ((counts.get("click") ?? 0) > 0) return "clicking";
    return "idle";
  }

  private eventTypeToIntentType(type: AgentEvent["type"]): IntentType {
    switch (type) {
      case "type": return "typing";
      case "click": return "clicking";
      case "scroll": return "scrolling";
      case "drag": return "dragging";
      case "navigate": return "navigating";
      case "idle":
      case "screenshot":
        return "idle";
    }
  }

  private computeBounds(group: AgentEvent[]): Rect {
    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;

    for (const e of group) {
      if (e.elementRect) {
        minX = Math.min(minX, e.elementRect.x);
        minY = Math.min(minY, e.elementRect.y);
        maxX = Math.max(maxX, e.elementRect.x + e.elementRect.width);
        maxY = Math.max(maxY, e.elementRect.y + e.elementRect.height);
      } else {
        minX = Math.min(minX, e.x);
        minY = Math.min(minY, e.y);
        maxX = Math.max(maxX, e.x);
        maxY = Math.max(maxY, e.y);
      }
    }

    // Minimum padding around the activity area
    const padX = Math.max(100, (maxX - minX) * 0.2);
    const padY = Math.max(100, (maxY - minY) * 0.2);

    return {
      x: minX - padX,
      y: minY - padY,
      width: (maxX - minX) + padX * 2,
      height: (maxY - minY) + padY * 2,
    };
  }

  private computeCenter(group: AgentEvent[], bounds: Rect): Point {
    // Weighted toward recent events (exponential decay)
    const lastT = group[group.length - 1].t;
    let weightSum = 0;
    let cx = 0;
    let cy = 0;

    for (const e of group) {
      const age = lastT - e.t;
      const weight = Math.exp(-age / 1000); // 1s half-life
      cx += e.x * weight;
      cy += e.y * weight;
      weightSum += weight;
    }

    if (weightSum > 0) {
      return { x: cx / weightSum, y: cy / weightSum };
    }
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  }

  private updateCenter(intent: Intent, event: AgentEvent): Point {
    // Exponentially weighted moving average
    const alpha = 0.3;
    return {
      x: intent.center.x + alpha * (event.x - intent.center.x),
      y: intent.center.y + alpha * (event.y - intent.center.y),
    };
  }

  private expandBounds(
    existing: Rect | undefined,
    event: AgentEvent,
  ): Rect {
    if (!existing) {
      return event.elementRect ?? {
        x: event.x - 50, y: event.y - 50, width: 100, height: 100,
      };
    }

    const ex = event.elementRect;
    const px = ex ? ex.x : event.x - 50;
    const py = ex ? ex.y : event.y - 50;
    const pw = ex ? ex.width : 100;
    const ph = ex ? ex.height : 100;

    const minX = Math.min(existing.x, px);
    const minY = Math.min(existing.y, py);
    const maxX = Math.max(existing.x + existing.width, px + pw);
    const maxY = Math.max(existing.y + existing.height, py + ph);

    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }
}
