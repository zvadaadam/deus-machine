import type { Intent, IntentType, Size } from "../types.js";
import { clamp } from "../interpolation/smoothstep.js";

/**
 * Zoom range per intent type.
 * Based on Screenize's ShotPlanner — higher zoom for focused activities.
 */
export interface ZoomRanges {
  typing: [number, number];
  clicking: [number, number];
  scrolling: [number, number];
  dragging: [number, number];
  navigating: [number, number];
  idle: [number, number];
}

export interface ShotPlannerConfig {
  /** Source content size. */
  sourceSize: Size;
  /** Minimum allowed zoom. Default: 1.0 */
  minZoom: number;
  /** Maximum allowed zoom. Default: 2.8 */
  maxZoom: number;
  /** Zoom ranges per intent type. */
  zoomRanges: ZoomRanges;
  /** Target area coverage: what fraction of the viewport the activity
   *  should occupy. Default: 0.6 (60%) */
  targetCoverage: number;
}

const DEFAULT_ZOOM_RANGES: ZoomRanges = {
  typing: [2.0, 2.5],
  clicking: [1.5, 2.5],
  scrolling: [1.0, 1.5],
  dragging: [1.3, 1.6],
  navigating: [1.0, 1.2],
  idle: [1.0, 1.0],
};

const DEFAULT_CONFIG: ShotPlannerConfig = {
  sourceSize: { width: 1920, height: 1080 },
  minZoom: 1.0,
  maxZoom: 2.8,
  zoomRanges: DEFAULT_ZOOM_RANGES,
  targetCoverage: 0.6,
};

/**
 * Computes zoom levels for classified intents.
 *
 * The shot planner decides how much to zoom in for each intent segment,
 * based on:
 * 1. The intent type (typing needs more zoom than scrolling)
 * 2. The activity bounding box (smaller area = more zoom)
 * 3. The target coverage (how much of the viewport should be filled)
 *
 * Priority:
 * 1. Element-based sizing (if activity has a bounding box)
 * 2. Activity bounding box area (for multi-event intents)
 * 3. Intent type midpoint (fallback)
 */
export class ShotPlanner {
  private config: ShotPlannerConfig;

  constructor(config: Partial<ShotPlannerConfig> = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      zoomRanges: { ...DEFAULT_ZOOM_RANGES, ...config.zoomRanges },
    };
  }

  /**
   * Compute zoom levels for a sequence of intents.
   * Mutates the `zoom` field of each intent in place and returns them.
   */
  plan(intents: Intent[]): Intent[] {
    for (const intent of intents) {
      intent.zoom = this.computeZoom(intent);
    }
    return intents;
  }

  /**
   * Compute zoom for a single intent.
   */
  computeZoom(intent: Intent): number {
    const range = this.config.zoomRanges[intent.type];
    const { sourceSize, targetCoverage, minZoom, maxZoom } = this.config;

    let zoom: number;

    if (intent.bounds && intent.bounds.width > 0 && intent.bounds.height > 0) {
      // Element-based sizing: zoom so the bounding box fills targetCoverage of viewport
      const boundsW = intent.bounds.width / sourceSize.width;
      const boundsH = intent.bounds.height / sourceSize.height;
      const boundsFraction = Math.max(boundsW, boundsH);

      if (boundsFraction > 0.01) {
        zoom = targetCoverage / boundsFraction;
      } else {
        // Very small element — use upper range
        zoom = range[1];
      }

      // Clamp to intent-specific range
      zoom = clamp(zoom, range[0], range[1]);
    } else {
      // No bounds info — use midpoint of range
      zoom = (range[0] + range[1]) / 2;
    }

    // Global clamp
    return clamp(zoom, minZoom, maxZoom);
  }

  /**
   * Get the zoom range for an intent type.
   */
  getRange(type: IntentType): [number, number] {
    return [...this.config.zoomRanges[type]];
  }
}
