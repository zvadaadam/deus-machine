/**
 * Abstract frame source interface.
 *
 * A frame source provides frames from some visual source — CDP screencast,
 * VNC stream, canvas capture, or screenshot polling. The recording session
 * consumes frames and passes them through the compositor.
 *
 * Implementations are platform-specific and live outside this package:
 * - Electron: CDP screencast via BrowserView webContents.debugger
 * - Browser: noVNC canvas.captureStream() or canvas.toBlob()
 * - Server: ffmpeg x11grab → pipe
 */
export interface FrameSource {
  /** Start producing frames. */
  start(): Promise<void>;

  /** Stop producing frames. */
  stop(): Promise<void>;

  /** Whether the source is currently active. */
  isActive(): boolean;

  /** Register a callback for new frames. */
  onFrame(callback: FrameCallback): void;

  /** Get the source resolution. */
  getSize(): { width: number; height: number };
}

/** A single frame with its metadata. */
export interface Frame {
  /** Raw image data. Varies by platform:
   *  - Browser: ImageBitmap
   *  - Node.js: Buffer / Uint8Array (JPEG/PNG bytes)
   *  - Canvas: ImageData
   */
  data: ImageBitmap | ImageData | ArrayBuffer | Uint8Array;

  /** Frame timestamp in milliseconds (relative to source start). */
  timestamp: number;

  /** Frame dimensions. */
  width: number;
  height: number;
}

export type FrameCallback = (frame: Frame) => void;

// ---------------------------------------------------------------------------
// CDP Screencast source config (for Electron BrowserView)
// ---------------------------------------------------------------------------

/**
 * Configuration for creating a CDP screencast frame source.
 *
 * CDP's Page.startScreencast sends JPEG frames at the requested rate.
 * This is the highest-quality approach for Electron BrowserView recording.
 *
 * Example (in Electron main process):
 * ```ts
 * const debugger = webContents.debugger;
 * debugger.attach('1.3');
 *
 * await debugger.sendCommand('Page.startScreencast', {
 *   format: 'jpeg',
 *   quality: 80,
 *   maxWidth: 1920,
 *   maxHeight: 1080,
 *   everyNthFrame: 2,
 * });
 *
 * debugger.on('message', (_, method, params) => {
 *   if (method === 'Page.screencastFrame') {
 *     const frameData = Buffer.from(params.data, 'base64');
 *     callback({ data: frameData, timestamp: params.metadata.timestamp * 1000, ... });
 *     debugger.sendCommand('Page.screencastFrameAck', { sessionId: params.sessionId });
 *   }
 * });
 * ```
 */
export interface CdpScreencastConfig {
  /** Image format. Default: "jpeg" */
  format: "jpeg" | "png";
  /** JPEG quality (1-100). Default: 80 */
  quality: number;
  /** Max frame width. Default: 1920 */
  maxWidth: number;
  /** Max frame height. Default: 1080 */
  maxHeight: number;
  /** Skip N-1 frames (1 = every frame, 2 = every other). Default: 2 */
  everyNthFrame: number;
}

export const DEFAULT_CDP_CONFIG: CdpScreencastConfig = {
  format: "jpeg",
  quality: 80,
  maxWidth: 1920,
  maxHeight: 1080,
  everyNthFrame: 2,
};

// ---------------------------------------------------------------------------
// Screenshot polling source config (fallback)
// ---------------------------------------------------------------------------

/**
 * Configuration for screenshot-based frame capture.
 *
 * Polls `capturePage()` at a fixed interval. Lower quality than CDP screencast
 * but works with any Electron webContents without debugger attachment.
 *
 * Example:
 * ```ts
 * const interval = setInterval(async () => {
 *   const image = await webContents.capturePage();
 *   const png = image.toPNG();
 *   callback({ data: png.buffer, timestamp: Date.now() - startTime, ... });
 * }, 1000 / fps);
 * ```
 */
export interface ScreenshotPollingConfig {
  /** Frames per second. Default: 15 */
  fps: number;
  /** Image format. Default: "png" */
  format: "png" | "jpeg";
  /** JPEG quality (if format is jpeg). Default: 80 */
  quality: number;
}

export const DEFAULT_SCREENSHOT_CONFIG: ScreenshotPollingConfig = {
  fps: 15,
  format: "png",
  quality: 80,
};

// ---------------------------------------------------------------------------
// VNC frame source config (for cloud agents)
// ---------------------------------------------------------------------------

/**
 * Configuration for VNC-based frame capture.
 *
 * noVNC renders the remote desktop to a <canvas>. We can capture
 * frames from this canvas using captureStream() or periodic toBlob().
 *
 * Example:
 * ```ts
 * const rfb = new RFB(container, wsUrl);
 * const canvas = container.querySelector('canvas');
 *
 * // Option A: captureStream (real-time, uses MediaRecorder internally)
 * const stream = canvas.captureStream(30);
 *
 * // Option B: periodic snapshot (simpler, works everywhere)
 * const interval = setInterval(() => {
 *   const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
 *   callback({ data: imageData, timestamp: Date.now() - startTime, ... });
 * }, 1000 / fps);
 * ```
 */
export interface VncFrameSourceConfig {
  /** WebSocket URL for the VNC server (via websockify). */
  wsUrl: string;
  /** Frames per second for canvas capture. Default: 30 */
  fps: number;
  /** Scale the VNC viewport to fit container. Default: true */
  scaleViewport: boolean;
  /** View-only mode (agent controls, user watches). Default: true */
  viewOnly: boolean;
}

export const DEFAULT_VNC_CONFIG: VncFrameSourceConfig = {
  wsUrl: "",
  fps: 30,
  scaleViewport: true,
  viewOnly: true,
};
