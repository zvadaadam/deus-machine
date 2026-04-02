/**
 * Timeline recorder that captures timed transforms for post-processing.
 *
 * Instead of encoding video in real-time, this captures the camera
 * timeline so you can render the final video later (with ffmpeg
 * or WebCodecs) at any quality level.
 */
export interface TimelineFrame {
  /** Timestamp in ms. */
  t: number;
  /** Camera transform at this frame. */
  camera: { x: number; y: number; zoom: number };
  /** Cursor state at this frame. */
  cursor: { x: number; y: number; clicking: boolean; visible: boolean };
}

/**
 * Simple timeline recorder — captures transforms for offline rendering.
 *
 * Usage:
 * ```ts
 * const recorder = new TimelineRecorder({ fps: 30 });
 * recorder.start();
 *
 * // During animation loop:
 * recorder.captureFrame(t, camera, cursor);
 *
 * // When done:
 * const timeline = recorder.stop();
 * // → TimelineFrame[] — pass to ffmpeg or WebCodecs for final render
 * ```
 */
export class TimelineRecorder {
  private frames: TimelineFrame[] = [];
  private recording = false;
  private fps: number;
  private lastFrameT = -Infinity;

  constructor(config: { fps?: number } = {}) {
    this.fps = config.fps ?? 30;
  }

  start(): void {
    this.frames = [];
    this.recording = true;
    this.lastFrameT = -Infinity;
  }

  captureFrame(
    t: number,
    camera: { x: number; y: number; zoom: number },
    cursor: { x: number; y: number; clicking: boolean; visible: boolean }
  ): void {
    if (!this.recording) return;

    // Enforce frame rate (skip if too soon)
    const minInterval = 1000 / this.fps;
    if (t - this.lastFrameT < minInterval * 0.9) return;

    this.frames.push({
      t,
      camera: { ...camera },
      cursor: { ...cursor },
    });
    this.lastFrameT = t;
  }

  stop(): TimelineFrame[] {
    this.recording = false;
    return this.frames;
  }

  isRecording(): boolean {
    return this.recording;
  }

  getFrameCount(): number {
    return this.frames.length;
  }

  getDuration(): number {
    if (this.frames.length < 2) return 0;
    return this.frames[this.frames.length - 1].t - this.frames[0].t;
  }
}
