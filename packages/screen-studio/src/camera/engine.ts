import type {
  AgentEvent,
  CameraState,
  CameraTransform,
  CursorState,
  DeadZoneConfig,
  Intent,
  Size,
  SpringConfig,
  TimedTransform,
} from "../types.js";
import { Spring, SPRING_PRESETS } from "./spring.js";
import { DeadZone, DEFAULT_DEAD_ZONE } from "./dead-zone.js";
import { IntentClassifier } from "../intent/classifier.js";
import { ShotPlanner, type ShotPlannerConfig } from "../intent/shot-planner.js";
import { clamp } from "../interpolation/smoothstep.js";

export interface CameraEngineConfig {
  /** Source content dimensions. */
  sourceSize: Size;
  /** Spring config for position (x, y). */
  positionSpring?: SpringConfig;
  /** Spring config for zoom. */
  zoomSpring?: SpringConfig;
  /** Spring config for cursor smoothing (stiffer than camera). */
  cursorSpring?: SpringConfig;
  /** Dead zone config. */
  deadZone?: DeadZoneConfig;
  /** Shot planner config. */
  shotPlanner?: Partial<ShotPlannerConfig>;
  /** Initial camera position (defaults to center, zoom 1). */
  initialState?: Partial<CameraState>;
  /** Minimum zoom. Default: 1.0 */
  minZoom?: number;
  /** Maximum zoom. Default: 2.8 */
  maxZoom?: number;
}

/**
 * The camera engine drives the auto-zoom and pan behavior.
 *
 * Feed it agent events (click, type, scroll, etc.) and call step()
 * at your desired frame rate. It returns the current camera transform
 * (x, y, zoom) that you use to render the composited output.
 *
 * Internally:
 * 1. Events are classified into intents (typing, clicking, scrolling...)
 * 2. Intents determine target zoom level (typing = 2x, scrolling = 1x)
 * 3. Spring physics smoothly animate the camera toward the target
 * 4. Dead zone prevents jittery movement from small cursor shifts
 *
 * Usage:
 * ```ts
 * const engine = new CameraEngine({ sourceSize: { width: 1920, height: 1080 } });
 *
 * // Feed events from agent
 * engine.pushEvent({ type: "click", x: 450, y: 320, t: 1200 });
 * engine.pushEvent({ type: "type", x: 450, y: 340, t: 1500 });
 *
 * // Step at 60fps
 * const transform = engine.step(1/60);
 * // → { x: 450, y: 330, zoom: 2.2 }
 * ```
 */
export class CameraEngine {
  private positionSpring: Spring;
  private zoomSpring: Spring;
  private cursorSpring: Spring;
  private deadZone: DeadZone;
  private classifier: IntentClassifier;
  private shotPlanner: ShotPlanner;
  private sourceSize: Size;
  private minZoom: number;
  private maxZoom: number;

  /** Current camera state (position + velocity). */
  private state: CameraState;

  /** Current target (where the camera wants to go). */
  private target: CameraTransform;

  /** Current intent driving the camera. */
  private currentIntent: Intent | null = null;

  /** Current cursor state (smoothly interpolated position). */
  private cursorState: CursorState;

  /** Cursor spring target position (set instantly by events). */
  private cursorTargetX: number;
  private cursorTargetY: number;

  /** Cursor spring velocity (for smooth interpolation). */
  private cursorVx = 0;
  private cursorVy = 0;

  /** Event buffer for batch classification. */
  private eventBuffer: AgentEvent[] = [];

  /** Accumulated time for the timeline. */
  private time = 0;

  constructor(config: CameraEngineConfig) {
    this.sourceSize = config.sourceSize;
    this.minZoom = config.minZoom ?? 1.0;
    this.maxZoom = config.maxZoom ?? 2.8;

    this.positionSpring = new Spring(
      config.positionSpring ?? SPRING_PRESETS.camera,
    );
    this.zoomSpring = new Spring(config.zoomSpring ?? SPRING_PRESETS.zoom);
    this.cursorSpring = new Spring(
      config.cursorSpring ?? { omega: 12, zeta: 0.75 },
    );
    this.deadZone = new DeadZone(config.deadZone ?? DEFAULT_DEAD_ZONE);

    this.classifier = new IntentClassifier({
      sourceSize: config.sourceSize,
    });

    this.shotPlanner = new ShotPlanner({
      sourceSize: config.sourceSize,
      minZoom: this.minZoom,
      maxZoom: this.maxZoom,
      ...config.shotPlanner,
    });

    // Initialize at center of source, zoom 1
    const cx = config.sourceSize.width / 2;
    const cy = config.sourceSize.height / 2;

    this.state = {
      x: config.initialState?.x ?? cx,
      y: config.initialState?.y ?? cy,
      zoom: config.initialState?.zoom ?? 1,
      vx: 0,
      vy: 0,
      vzoom: 0,
    };

    this.target = { x: this.state.x, y: this.state.y, zoom: this.state.zoom };

    this.cursorTargetX = cx;
    this.cursorTargetY = cy;

    this.cursorState = {
      x: cx,
      y: cy,
      clicking: false,
      clickAge: 0,
      visible: false,
      vx: 0,
      vy: 0,
    };
  }

  /**
   * Push an agent event. The engine classifies it and updates the target.
   * Cursor position is set as a spring target — it interpolates smoothly
   * in step() rather than teleporting.
   */
  pushEvent(event: AgentEvent): void {
    this.eventBuffer.push(event);

    // Set cursor spring target (actual position interpolates in step())
    this.cursorTargetX = event.x;
    this.cursorTargetY = event.y;
    this.cursorState.visible = true;

    if (event.type === "click") {
      this.cursorState.clicking = true;
      this.cursorState.clickAge = 0;
    }

    // Incremental intent classification
    this.currentIntent = this.classifier.classifyIncremental(
      event,
      this.currentIntent,
    );

    // Compute zoom for the updated intent
    this.currentIntent.zoom = this.shotPlanner.computeZoom(this.currentIntent);

    // Update target
    this.target = {
      x: this.currentIntent.center.x,
      y: this.currentIntent.center.y,
      zoom: this.currentIntent.zoom,
    };
  }

  /**
   * Advance the camera by dt seconds.
   * Call this at your render frame rate (e.g. 1/60 for 60fps).
   *
   * @param dt Time step in seconds
   * @returns  Current camera transform for rendering
   */
  step(dt: number): CameraTransform {
    this.time += dt * 1000; // track time in ms

    // Dead zone: adjust target so camera holds still for small movements
    const viewportW = this.sourceSize.width / this.state.zoom;
    const viewportH = this.sourceSize.height / this.state.zoom;

    const adjustedTarget = this.deadZone.computeTarget(
      { x: this.state.x, y: this.state.y },
      { x: this.target.x, y: this.target.y },
      { width: viewportW, height: viewportH },
    );

    // Step position springs
    const [newX, newVx] = this.positionSpring.step(
      this.state.x, this.state.vx, adjustedTarget.x, dt,
    );
    const [newY, newVy] = this.positionSpring.step(
      this.state.y, this.state.vy, adjustedTarget.y, dt,
    );

    // Step zoom spring
    const clampedTargetZoom = clamp(this.target.zoom, this.minZoom, this.maxZoom);
    const [newZoom, newVzoom] = this.zoomSpring.step(
      this.state.zoom, this.state.vzoom, clampedTargetZoom, dt,
    );

    // Clamp position to keep viewport within source bounds
    const halfViewW = this.sourceSize.width / (2 * newZoom);
    const halfViewH = this.sourceSize.height / (2 * newZoom);

    this.state = {
      x: clamp(newX, halfViewW, this.sourceSize.width - halfViewW),
      y: clamp(newY, halfViewH, this.sourceSize.height - halfViewH),
      zoom: clamp(newZoom, this.minZoom, this.maxZoom),
      vx: newVx,
      vy: newVy,
      vzoom: newVzoom,
    };

    // Step cursor spring (smooth interpolation toward target)
    const [newCursorX, newCursorVx] = this.cursorSpring.step(
      this.cursorState.x, this.cursorVx, this.cursorTargetX, dt,
    );
    const [newCursorY, newCursorVy] = this.cursorSpring.step(
      this.cursorState.y, this.cursorVy, this.cursorTargetY, dt,
    );

    this.cursorVx = newCursorVx;
    this.cursorVy = newCursorVy;
    this.cursorState.x = newCursorX;
    this.cursorState.y = newCursorY;
    this.cursorState.vx = newCursorVx;
    this.cursorState.vy = newCursorVy;

    // Update click ripple age (400ms total for dual-ring animation)
    if (this.cursorState.clicking) {
      this.cursorState.clickAge += dt * 1000;
      if (this.cursorState.clickAge > 400) {
        this.cursorState.clicking = false;
        this.cursorState.clickAge = 0;
      }
    }

    return this.getTransform();
  }

  /**
   * Get the current camera transform (read-only snapshot).
   */
  getTransform(): CameraTransform {
    return { x: this.state.x, y: this.state.y, zoom: this.state.zoom };
  }

  /**
   * Get the current camera state including velocities.
   */
  getState(): CameraState {
    return { ...this.state };
  }

  /**
   * Get the current cursor state.
   */
  getCursorState(): CursorState {
    return { ...this.cursorState };
  }

  /**
   * Get the current intent (if any).
   */
  getCurrentIntent(): Intent | null {
    return this.currentIntent ? { ...this.currentIntent } : null;
  }

  /**
   * Get a timed transform for the current frame (for timeline recording).
   */
  getTimedTransform(): TimedTransform {
    return {
      t: this.time,
      camera: this.getTransform(),
      cursor: this.getCursorState(),
    };
  }

  /**
   * Jump the camera instantly to a position (no spring animation).
   * Useful for initial setup or scene cuts.
   */
  jumpTo(transform: Partial<CameraTransform>): void {
    if (transform.x !== undefined) {
      this.state.x = transform.x;
      this.state.vx = 0;
      this.target.x = transform.x;
    }
    if (transform.y !== undefined) {
      this.state.y = transform.y;
      this.state.vy = 0;
      this.target.y = transform.y;
    }
    if (transform.zoom !== undefined) {
      this.state.zoom = transform.zoom;
      this.state.vzoom = 0;
      this.target.zoom = transform.zoom;
    }
    this.deadZone.reset();
  }

  /**
   * Set target directly (bypassing intent classification).
   * Useful when you want manual camera control.
   */
  setTarget(target: Partial<CameraTransform>): void {
    if (target.x !== undefined) this.target.x = target.x;
    if (target.y !== undefined) this.target.y = target.y;
    if (target.zoom !== undefined) this.target.zoom = target.zoom;
  }

  /**
   * Check if the camera has settled (reached target, no velocity).
   */
  isSettled(threshold = 0.5): boolean {
    return (
      this.positionSpring.isSettled(this.state.x, this.state.vx, this.target.x, threshold) &&
      this.positionSpring.isSettled(this.state.y, this.state.vy, this.target.y, threshold) &&
      this.zoomSpring.isSettled(this.state.zoom, this.state.vzoom, this.target.zoom, 0.01)
    );
  }

  /**
   * Process all buffered events as a batch (for offline/post-processing).
   * Returns a timeline of timed transforms.
   *
   * @param fps      Target frame rate
   * @param duration Total duration in seconds (defaults to event span + 2s settle)
   */
  processTimeline(fps = 30, duration?: number): TimedTransform[] {
    const events = this.eventBuffer;
    if (events.length === 0) return [];

    // Classify all events
    const intents = this.classifier.classify(events);
    this.shotPlanner.plan(intents);

    // Reset camera to starting position
    const firstEvent = events[0];
    this.jumpTo({ x: firstEvent.x, y: firstEvent.y, zoom: 1 });
    this.time = firstEvent.t;

    const dt = 1 / fps;
    const startT = firstEvent.t;
    const endT = duration
      ? startT + duration * 1000
      : events[events.length - 1].t + 2000;

    const timeline: TimedTransform[] = [];
    let eventIdx = 0;
    let intentIdx = 0;

    for (let t = startT; t <= endT; t += dt * 1000) {
      // Feed events up to current time
      while (eventIdx < events.length && events[eventIdx].t <= t) {
        this.cursorTargetX = events[eventIdx].x;
        this.cursorTargetY = events[eventIdx].y;
        this.cursorState.visible = true;
        if (events[eventIdx].type === "click") {
          this.cursorState.clicking = true;
          this.cursorState.clickAge = 0;
        }
        eventIdx++;
      }

      // Find active intent at time t
      while (
        intentIdx < intents.length - 1 &&
        intents[intentIdx + 1].startT <= t
      ) {
        intentIdx++;
      }

      if (intentIdx < intents.length) {
        const intent = intents[intentIdx];
        this.target = {
          x: intent.center.x,
          y: intent.center.y,
          zoom: intent.zoom,
        };
      }

      // Step the camera. step(dt) internally increments this.time, but we
      // override it with the authoritative timeline time `t` so that
      // getTimedTransform() reports the correct timestamp. The step() side
      // effect on this.time is harmless — the override ensures correctness.
      this.step(dt);
      this.time = t;

      timeline.push(this.getTimedTransform());
    }

    return timeline;
  }

  /**
   * Reset the engine to its initial state.
   */
  reset(): void {
    const cx = this.sourceSize.width / 2;
    const cy = this.sourceSize.height / 2;

    this.state = { x: cx, y: cy, zoom: 1, vx: 0, vy: 0, vzoom: 0 };
    this.target = { x: cx, y: cy, zoom: 1 };
    this.currentIntent = null;
    this.eventBuffer = [];
    this.time = 0;
    this.deadZone.reset();
    this.cursorTargetX = cx;
    this.cursorTargetY = cy;
    this.cursorVx = 0;
    this.cursorVy = 0;
    this.cursorState = {
      x: cx, y: cy, clicking: false, clickAge: 0, visible: false, vx: 0, vy: 0,
    };
  }
}
