import type { DeadZoneConfig, Point, Size } from "../types.js";
import { smoothstep } from "../interpolation/smoothstep.js";

/**
 * Dead zone targeting for the camera.
 *
 * When the target point is within the dead zone (centered on the camera),
 * the camera holds still. When it exits, the camera catches up with
 * smooth interpolation through a gradient band.
 *
 * This prevents the camera from constantly chasing tiny cursor movements,
 * which would feel jittery. The camera only moves when the cursor
 * meaningfully leaves the current view region.
 *
 * Hysteresis prevents chattering at the boundary: entering the zone
 * requires crossing a wider threshold than exiting.
 */
export class DeadZone {
  readonly fraction: number;
  readonly hysteresis: number;

  /** Tracks whether we're currently inside the dead zone per axis. */
  private insideX = true;
  private insideY = true;

  constructor(config: DeadZoneConfig) {
    if (!Number.isFinite(config.fraction) || config.fraction <= 0 || config.fraction >= 1) {
      throw new RangeError("deadZone.fraction must be > 0 and < 1");
    }
    if (!Number.isFinite(config.hysteresis) || config.hysteresis < 0 || config.hysteresis >= config.fraction) {
      throw new RangeError("deadZone.hysteresis must be >= 0 and < fraction");
    }
    this.fraction = config.fraction;
    this.hysteresis = config.hysteresis;
  }

  /**
   * Compute the effective camera target given the raw target and current camera position.
   *
   * @param cameraCenter  Current camera center (source coordinates)
   * @param rawTarget     Desired target (where the cursor/action is)
   * @param viewportSize  Current viewport size in source coordinates (accounting for zoom)
   * @returns             Adjusted target — same as camera if inside dead zone
   */
  computeTarget(
    cameraCenter: Point,
    rawTarget: Point,
    viewportSize: Size,
  ): Point {
    return {
      x: this.axisTarget(
        cameraCenter.x,
        rawTarget.x,
        viewportSize.width,
        "x",
      ),
      y: this.axisTarget(
        cameraCenter.y,
        rawTarget.y,
        viewportSize.height,
        "y",
      ),
    };
  }

  /**
   * Reset the dead zone state (e.g. when jumping to a new position).
   */
  reset(): void {
    this.insideX = true;
    this.insideY = true;
  }

  /**
   * Per-axis dead zone computation with hysteresis and gradient band.
   */
  private axisTarget(
    cameraPos: number,
    targetPos: number,
    viewportExtent: number,
    axis: "x" | "y",
  ): number {
    const halfExtent = viewportExtent / 2;
    const safeHalf = halfExtent * this.fraction;
    const hysteresisHalf = halfExtent * this.hysteresis;

    const delta = targetPos - cameraPos;
    const absDelta = Math.abs(delta);

    // Determine inside/outside with hysteresis
    const inside = axis === "x" ? this.insideX : this.insideY;
    const enterThreshold = safeHalf + hysteresisHalf;
    const exitThreshold = safeHalf - hysteresisHalf;

    let nowInside: boolean;
    if (inside) {
      // Currently inside — need to exceed enter threshold to leave
      nowInside = absDelta < enterThreshold;
    } else {
      // Currently outside — need to come within exit threshold to re-enter
      nowInside = absDelta < exitThreshold;
    }

    if (axis === "x") this.insideX = nowInside;
    else this.insideY = nowInside;

    if (nowInside) {
      // Inside dead zone: camera stays put
      return cameraPos;
    }

    // Outside dead zone: smooth gradient band
    // The gradient band extends from safeHalf to halfExtent
    const gradientStart = safeHalf;
    const gradientEnd = halfExtent;

    // How far past the safe zone (0 = at edge, 1 = at viewport edge)
    const t = smoothstep(gradientStart, gradientEnd, absDelta);

    // Blend between camera position and full correction
    const correction = delta * t;
    return cameraPos + correction;
  }
}

/** Default dead zone config. */
export const DEFAULT_DEAD_ZONE: DeadZoneConfig = {
  fraction: 0.15,
  hysteresis: 0.03,
};
