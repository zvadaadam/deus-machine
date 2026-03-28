import type {
  CameraTransform,
  CompositorConfig,
  CursorState,
  Size,
} from "../types.js";
import { clamp } from "../interpolation/smoothstep.js";

/**
 * Canvas-agnostic rendering instructions.
 *
 * The compositor computes transforms and draw commands
 * without depending on any specific canvas API.
 * This makes it testable in Node.js and usable in both
 * browser (HTMLCanvasElement) and server (node-canvas, sharp).
 */

/** Source region to extract from the frame. */
export interface SourceRegion {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/** Destination region to draw into on the output canvas. */
export interface DestRegion {
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

/** Cursor draw command. */
export interface CursorDrawCommand {
  x: number;
  y: number;
  size: number;
  visible: boolean;
  /** Cursor velocity in output pixels/s (for motion effects). */
  vx: number;
  vy: number;
  ripple: {
    active: boolean;
    /** Normalized progress [0..1] for the full ripple animation. */
    progress: number;
    radius: number;
    opacity: number;
  };
  spotlight: {
    active: boolean;
    radius: number;
    color: string;
  };
  /** Whether to render dual-ring ripple. */
  dualRipple: boolean;
}

/** Device frame draw info. */
export interface DeviceFrameDrawInfo {
  /** Outer bounds of the device frame (including chrome). */
  outer: DestRegion;
  /** Inner bounds where content is rendered. */
  inner: DestRegion;
  /** Title bar height. */
  titleBarHeight: number;
  /** Corner radius. */
  cornerRadius: number;
  /** Title text. */
  title: string;
}

/** Full frame render instructions. */
export interface RenderInstructions {
  /** Source region to crop from the input frame. */
  source: SourceRegion;
  /** Destination region for the content (inside device frame). */
  content: DestRegion;
  /** Cursor overlay command. */
  cursor: CursorDrawCommand;
  /** Device frame info (null if frame type is "none"). */
  deviceFrame: DeviceFrameDrawInfo | null;
  /** Output canvas size. */
  outputSize: Size;
}

/** Default padding for device frames. */
const FRAME_PADDING = {
  "browser-chrome": { top: 40, right: 0, bottom: 0, left: 0 },
  "macos-window": { top: 32, right: 0, bottom: 0, left: 0 },
  none: { top: 0, right: 0, bottom: 0, left: 0 },
} as const;

/** Margin between output edge and device frame. */
const FRAME_MARGIN = 40;

/**
 * Compositor computes rendering instructions from camera state.
 *
 * It doesn't touch any canvas directly — it produces pure data
 * describing what to draw where. A platform-specific renderer
 * (browser canvas, node-canvas, sharp) consumes these instructions.
 *
 * Usage:
 * ```ts
 * const compositor = new Compositor({ ... });
 * const instructions = compositor.computeFrame(camera, cursor);
 * // Pass instructions to your canvas renderer
 * ```
 */
export class Compositor {
  private config: CompositorConfig;

  constructor(config: CompositorConfig) {
    this.config = config;
  }

  /**
   * Compute render instructions for a single frame.
   */
  computeFrame(
    camera: CameraTransform,
    cursor: CursorState,
  ): RenderInstructions {
    const { source, output, deviceFrame: frameConfig, cursor: cursorConfig } = this.config;

    // Compute device frame regions
    const padding = frameConfig.padding ??
      FRAME_PADDING[frameConfig.type] ??
      FRAME_PADDING.none;
    const cornerRadius = frameConfig.cornerRadius ?? 12;

    const hasFrame = frameConfig.type !== "none";

    // Content area within the output (accounting for frame + margin)
    const contentArea = hasFrame
      ? {
          dx: FRAME_MARGIN,
          dy: FRAME_MARGIN + padding.top,
          dw: output.width - FRAME_MARGIN * 2,
          dh: output.height - FRAME_MARGIN * 2 - padding.top - padding.bottom,
        }
      : {
          dx: 0,
          dy: 0,
          dw: output.width,
          dh: output.height,
        };

    // Source region: what part of the source image to show
    // Zoom determines how much of the source is visible
    const viewW = source.width / camera.zoom;
    const viewH = source.height / camera.zoom;

    // Center the view on the camera position
    const sx = clamp(camera.x - viewW / 2, 0, source.width - viewW);
    const sy = clamp(camera.y - viewH / 2, 0, source.height - viewH);

    // Cursor position in output coordinates
    const cursorOutputX =
      contentArea.dx + ((cursor.x - sx) / viewW) * contentArea.dw;
    const cursorOutputY =
      contentArea.dy + ((cursor.y - sy) / viewH) * contentArea.dh;

    // Scale factor from source to output pixels (for velocity conversion)
    const sourceToOutputScale = contentArea.dw / viewW;

    // Cursor stays the same visual size on screen regardless of zoom.
    // No scaling needed — the cursor is drawn in output coordinates.
    const effectiveSize = cursorConfig.size;

    // Ripple animation
    const rippleDuration = cursorConfig.rippleDuration || 400;
    const rippleProgress = cursor.clicking
      ? clamp(cursor.clickAge / rippleDuration, 0, 1)
      : 0;
    const rippleRadius = rippleProgress * 30 * (effectiveSize / 24);
    const rippleOpacity = 1 - rippleProgress;

    // Spotlight config
    const showSpotlight = cursorConfig.showSpotlight ?? true;
    const spotlightRadius = cursorConfig.spotlightRadius ?? 40;
    const spotlightColor = cursorConfig.spotlightColor ?? "rgba(58, 150, 221, 0.15)";

    // Device frame info
    let deviceFrameInfo: DeviceFrameDrawInfo | null = null;
    if (hasFrame) {
      deviceFrameInfo = {
        outer: {
          dx: FRAME_MARGIN,
          dy: FRAME_MARGIN,
          dw: output.width - FRAME_MARGIN * 2,
          dh: output.height - FRAME_MARGIN * 2,
        },
        inner: contentArea,
        titleBarHeight: padding.top,
        cornerRadius,
        title: frameConfig.title ?? "",
      };
    }

    return {
      source: { sx, sy, sw: viewW, sh: viewH },
      content: contentArea,
      cursor: {
        x: cursorOutputX,
        y: cursorOutputY,
        size: effectiveSize,
        visible: cursorConfig.visible && cursor.visible,
        vx: (cursor.vx ?? 0) * sourceToOutputScale,
        vy: (cursor.vy ?? 0) * sourceToOutputScale,
        ripple: {
          active: cursor.clicking && cursorConfig.showClickRipple,
          progress: rippleProgress,
          radius: rippleRadius,
          opacity: rippleOpacity,
        },
        spotlight: {
          active: showSpotlight && cursorConfig.visible && cursor.visible,
          radius: spotlightRadius,
          color: spotlightColor,
        },
        dualRipple: cursorConfig.dualRipple ?? true,
      },
      deviceFrame: deviceFrameInfo,
      outputSize: output,
    };
  }

  /**
   * Get the source size.
   */
  getSourceSize(): Size {
    return { ...this.config.source };
  }

  /**
   * Get the output size.
   */
  getOutputSize(): Size {
    return { ...this.config.output };
  }

  /**
   * Update the config (e.g. when source size changes).
   */
  updateConfig(partial: Partial<CompositorConfig>): void {
    Object.assign(this.config, partial);
  }
}
