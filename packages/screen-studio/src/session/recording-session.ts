import type {
  AgentEvent,
  BackgroundConfig,
  CameraTransform,
  CompositorConfig,
  CursorConfig,
  CursorState,
  DeviceFrameConfig,
  Size,
  TimedTransform,
} from "../types.js";
import { CameraEngine, type CameraEngineConfig } from "../camera/engine.js";
import { Compositor, type RenderInstructions } from "../compositor/renderer.js";
import { TimelineRecorder, type TimelineFrame } from "../recorder/encoder.js";
import type { McpToolEvent } from "../adapter/mcp-adapter.js";
import { McpToolAdapter, type ElementResolver } from "../adapter/mcp-adapter.js";

export type SessionStatus = "idle" | "recording" | "paused" | "stopped";

export interface RecordingSessionConfig {
  /** Source content dimensions (the browser viewport size). */
  sourceSize: Size;
  /** Output video dimensions. */
  outputSize: Size;
  /** Target frames per second. Default: 30 */
  fps?: number;
  /** Camera engine config overrides. */
  camera?: Partial<CameraEngineConfig>;
  /** Device frame config. */
  deviceFrame?: DeviceFrameConfig;
  /** Background config. */
  background?: BackgroundConfig;
  /** Cursor config. */
  cursor?: Partial<CursorConfig>;
  /** Element resolver for MCP tool events (maps ref IDs to coordinates). */
  elementResolver?: ElementResolver;
}

/**
 * RecordingSession orchestrates the full recording pipeline.
 *
 * It's the main entry point for recording an agent's browser session.
 * It ties together:
 * - MCP event adapter (tool events → camera events)
 * - Camera engine (auto-zoom + pan)
 * - Compositor (render instructions)
 * - Timeline recorder (frame capture)
 *
 * Two modes:
 *
 * **Real-time mode** — call `tick()` at your frame rate during the session.
 * Each tick advances the camera and returns render instructions you can
 * paint on a canvas. Great for live preview.
 *
 * **Post-processing mode** — feed all events, then call `renderTimeline()`
 * to get the full sequence of transforms for ffmpeg or WebCodecs.
 *
 * Usage (real-time):
 * ```ts
 * const session = new RecordingSession({
 *   sourceSize: { width: 1920, height: 1080 },
 *   outputSize: { width: 1920, height: 1080 },
 *   elementResolver: async (ref) => queryBrowserForElementRect(ref),
 * });
 *
 * session.start();
 *
 * // When MCP tool event arrives:
 * await session.handleToolEvent({ method: "browserClick", params: { ref: "@e5" }, ... });
 *
 * // In your render loop (60fps):
 * const { camera, instructions, cursor } = session.tick();
 * canvasRenderer.renderFrame(browserFrame, instructions, background);
 *
 * // When session ends:
 * const timeline = session.stop();
 * ```
 *
 * Usage (post-processing):
 * ```ts
 * const session = new RecordingSession({ ... });
 *
 * // Feed all events at once:
 * for (const event of recordedEvents) {
 *   await session.handleToolEvent(event);
 * }
 *
 * // Generate timeline for encoding:
 * const timeline = session.renderTimeline(30);
 * const ffmpegFilter = generateFfmpegFilter(timeline, sourceSize, outputSize);
 * ```
 */
export class RecordingSession {
  private engine: CameraEngine;
  private compositor: Compositor;
  private recorder: TimelineRecorder;
  private adapter: McpToolAdapter;
  private config: Required<Pick<RecordingSessionConfig, "fps" | "sourceSize" | "outputSize">>;
  private backgroundConfig: BackgroundConfig;
  private deviceFrameConfig: DeviceFrameConfig;

  private status: SessionStatus = "idle";
  private lastTickTime = 0;
  private sessionStartTime = 0;
  private eventLog: AgentEvent[] = [];

  constructor(config: RecordingSessionConfig) {
    const fps = config.fps ?? 30;
    const sourceSize = config.sourceSize;
    const outputSize = config.outputSize;

    this.config = { fps, sourceSize, outputSize };

    this.engine = new CameraEngine({
      sourceSize,
      ...config.camera,
    });

    const cursorConfig: CursorConfig = {
      visible: true,
      size: 24,
      showClickRipple: true,
      rippleDuration: 400,
      showSpotlight: true,
      spotlightRadius: 40,
      spotlightColor: "rgba(58, 150, 221, 0.15)",
      dualRipple: true,
      ...config.cursor,
    };

    const compositorConfig: CompositorConfig = {
      output: outputSize,
      source: sourceSize,
      deviceFrame: config.deviceFrame ?? { type: "browser-chrome" },
      background: config.background ?? {
        type: "gradient",
        colors: ["#0f0f23", "#1a1a3e"],
      },
      cursor: cursorConfig,
    };

    this.backgroundConfig = compositorConfig.background;
    this.deviceFrameConfig = compositorConfig.deviceFrame;
    this.compositor = new Compositor(compositorConfig);
    this.recorder = new TimelineRecorder({ fps });

    // Adapter with resolver (or no-op fallback)
    const resolver: ElementResolver = config.elementResolver ??
      (async () => null);
    this.adapter = new McpToolAdapter(resolver, sourceSize);
  }

  /**
   * Start recording.
   */
  start(): void {
    if (this.status === "recording") return;

    this.status = "recording";
    this.sessionStartTime = Date.now();
    this.lastTickTime = performance.now();
    this.recorder.start();
  }

  /**
   * Pause recording (camera holds position).
   */
  pause(): void {
    if (this.status !== "recording") return;
    this.status = "paused";
  }

  /**
   * Resume from pause.
   */
  resume(): void {
    if (this.status !== "paused") return;
    this.status = "recording";
    this.lastTickTime = performance.now();
  }

  /**
   * Stop recording and return the captured timeline.
   */
  stop(): TimelineFrame[] {
    if (this.status === "idle" || this.status === "stopped") return [];

    this.status = "stopped";
    return this.recorder.stop();
  }

  /**
   * Handle an MCP tool event from the tool relay.
   *
   * Resolves element positions and feeds the event to the camera engine.
   * Call this whenever a tool.request arrives.
   */
  async handleToolEvent(event: McpToolEvent): Promise<void> {
    const agentEvent = await this.adapter.adapt(event);
    if (!agentEvent) return;

    this.eventLog.push(agentEvent);
    this.engine.pushEvent(agentEvent);
  }

  /**
   * Handle a raw agent event (if you already have coordinates).
   */
  handleAgentEvent(event: AgentEvent): void {
    this.eventLog.push(event);
    this.engine.pushEvent(event);
  }

  /**
   * Advance one frame. Call at your render frame rate.
   *
   * Returns the camera transform and render instructions for this frame.
   * Use the instructions to render onto a canvas.
   */
  tick(): TickResult {
    const now = performance.now();
    const dt = Math.min((now - this.lastTickTime) / 1000, 0.1); // cap at 100ms
    this.lastTickTime = now;

    if (this.status !== "recording") {
      // Return current state without advancing
      return this.currentFrame();
    }

    const camera = this.engine.step(dt);
    const cursor = this.engine.getCursorState();
    const instructions = this.compositor.computeFrame(camera, cursor);

    // Capture to timeline
    this.recorder.captureFrame(
      Date.now() - this.sessionStartTime,
      camera,
      { x: cursor.x, y: cursor.y, clicking: cursor.clicking, visible: cursor.visible },
    );

    return { camera, cursor, instructions };
  }

  /**
   * Get current frame without advancing time (for snapshots).
   */
  currentFrame(): TickResult {
    const camera = this.engine.getTransform();
    const cursor = this.engine.getCursorState();
    const instructions = this.compositor.computeFrame(camera, cursor);
    return { camera, cursor, instructions };
  }

  /**
   * Generate a complete timeline from all recorded events.
   * Use for post-processing with ffmpeg or WebCodecs.
   *
   * @param fps Frame rate for the output timeline
   * @param duration Duration in seconds (defaults to event span + settle time)
   */
  renderTimeline(fps?: number, duration?: number): TimedTransform[] {
    return this.engine.processTimeline(fps ?? this.config.fps, duration);
  }

  /**
   * Get all recorded events (for serialization/replay).
   */
  getEventLog(): AgentEvent[] {
    return [...this.eventLog];
  }

  /**
   * Get current status.
   */
  getStatus(): SessionStatus {
    return this.status;
  }

  /**
   * Get the background config (for passing to CanvasRenderer).
   */
  getBackgroundConfig(): BackgroundConfig {
    return this.backgroundConfig;
  }

  /**
   * Update the device frame title (e.g. when page URL changes).
   */
  setTitle(title: string): void {
    this.deviceFrameConfig = { ...this.deviceFrameConfig, title };
    this.compositor.updateConfig({
      deviceFrame: this.deviceFrameConfig,
    });
  }

  /**
   * Check if the camera has settled (no animation in progress).
   */
  isCameraSettled(): boolean {
    return this.engine.isSettled();
  }

  /**
   * Jump camera to a specific position (instant, no animation).
   */
  jumpCamera(transform: Partial<CameraTransform>): void {
    this.engine.jumpTo(transform);
  }

  /**
   * Reset the session completely.
   */
  reset(): void {
    this.engine.reset();
    this.status = "idle";
    this.eventLog = [];
    this.lastTickTime = 0;
    this.sessionStartTime = 0;
  }

}

/** Result of a single tick/frame. */
export interface TickResult {
  camera: CameraTransform;
  cursor: CursorState;
  instructions: RenderInstructions;
}
