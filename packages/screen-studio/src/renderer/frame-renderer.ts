/**
 * Frame-level renderer: source JPEG + camera transform → rendered JPEG.
 *
 * Uses @napi-rs/canvas (Skia) for rendering with cursor overlay,
 * click ripples, spotlight effects. Falls back gracefully if canvas
 * dependency is not available.
 */

import type {
  Size,
  TimedTransform,
  CompositorConfig,
  BackgroundConfig,
  DeviceFrameConfig,
  CursorConfig,
} from "../types.js";
import { Compositor } from "../compositor/renderer.js";
import { CanvasRenderer } from "../compositor/canvas-renderer.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RenderConfig {
  sourceSize: Size;
  outputSize: Size;
  background?: BackgroundConfig;
  deviceFrame?: DeviceFrameConfig;
  cursor?: CursorConfig;
}

export interface FrameRendererContext {
  compositor: Compositor;
  canvasRenderer: CanvasRenderer;
  canvas: any;
  loadImage: (buf: Buffer) => Promise<any>;
}

// ---------------------------------------------------------------------------
// Canvas availability (cached dynamic import)
// ---------------------------------------------------------------------------

let canvasModule: any | null = null;
let canvasChecked = false;

async function getCanvasModule(): Promise<any | null> {
  if (canvasChecked) return canvasModule;
  canvasChecked = true;
  try {
    // Dynamic require to prevent esbuild from bundling the native .node binary.
    // @napi-rs/canvas is an optional peer dependency with a native Skia backend.
    const moduleName = "@napi-rs/canvas";
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    canvasModule = require(moduleName);
    return canvasModule;
  } catch {
    return null;
  }
}

export async function isCanvasAvailable(): Promise<boolean> {
  return (await getCanvasModule()) !== null;
}

// ---------------------------------------------------------------------------
// Create reusable renderer context
// ---------------------------------------------------------------------------

const DEFAULT_BACKGROUND: BackgroundConfig = {
  type: "solid",
  colors: ["#0f0f23"],
};

const DEFAULT_CURSOR: CursorConfig = {
  visible: true,
  size: 24,
  showClickRipple: true,
  rippleDuration: 400,
  showSpotlight: false,
  spotlightRadius: 40,
  spotlightColor: "rgba(58, 150, 221, 0.15)",
  dualRipple: false,
};

export async function createFrameRenderer(
  config: RenderConfig
): Promise<FrameRendererContext | null> {
  const mod = await getCanvasModule();
  if (!mod) return null;

  const { createCanvas, loadImage } = mod;
  const canvas = createCanvas(config.outputSize.width, config.outputSize.height);
  const ctx = canvas.getContext("2d");

  const compositorConfig: CompositorConfig = {
    source: config.sourceSize,
    output: config.outputSize,
    deviceFrame: config.deviceFrame ?? { type: "none" },
    background: config.background ?? DEFAULT_BACKGROUND,
    cursor: config.cursor ?? DEFAULT_CURSOR,
  };

  const compositor = new Compositor(compositorConfig);
  const canvasRenderer = new CanvasRenderer(ctx as unknown as CanvasRenderingContext2D);

  return { compositor, canvasRenderer, canvas, loadImage };
}

// ---------------------------------------------------------------------------
// Render a single frame
// ---------------------------------------------------------------------------

export async function renderFrame(
  sourceJpeg: Buffer,
  transform: TimedTransform,
  config: RenderConfig,
  ctx: FrameRendererContext
): Promise<Buffer> {
  const { compositor, canvasRenderer, canvas, loadImage } = ctx;

  // Decode source JPEG
  const sourceImage = await loadImage(sourceJpeg);

  // Compute render instructions (crop region, cursor position, effects)
  const instructions = compositor.computeFrame(transform.camera, transform.cursor);

  // Draw: background → device frame → content → cursor
  canvasRenderer.renderFrame(
    sourceImage as any,
    instructions,
    config.background ?? DEFAULT_BACKGROUND
  );

  // Encode output as JPEG
  return canvas.encodeSync("jpeg", 90);
}
