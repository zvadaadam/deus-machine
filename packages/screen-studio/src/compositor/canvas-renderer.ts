import type { BackgroundConfig, Size } from "../types.js";
import type { RenderInstructions } from "./renderer.js";

// ---------------------------------------------------------------------------
// Device frame color constants
// ---------------------------------------------------------------------------

/** macOS traffic light button colors (close, minimize, maximize). */
const TRAFFIC_LIGHT_CLOSE = "#ff5f57";
const TRAFFIC_LIGHT_MINIMIZE = "#febc2e";
const TRAFFIC_LIGHT_MAXIMIZE = "#28c840";

/** Title bar background color. */
const TITLE_BAR_COLOR = "#2c2c2e";
/** Outer frame / window background color. */
const FRAME_BG_COLOR = "#1c1c1e";

/**
 * Canvas 2D renderer that executes RenderInstructions.
 *
 * Works with both browser HTMLCanvasElement and node-canvas.
 * Accepts any object matching the CanvasRenderingContext2D interface.
 *
 * Usage (browser):
 * ```ts
 * const canvas = document.createElement("canvas");
 * const ctx = canvas.getContext("2d")!;
 * const renderer = new CanvasRenderer(ctx);
 * renderer.renderFrame(sourceImage, instructions, backgroundConfig);
 * ```
 *
 * Usage (Node.js with @napi-rs/canvas or canvas):
 * ```ts
 * import { createCanvas } from "@napi-rs/canvas";
 * const canvas = createCanvas(1920, 1080);
 * const ctx = canvas.getContext("2d");
 * const renderer = new CanvasRenderer(ctx);
 * ```
 */
export class CanvasRenderer {
  private ctx: CanvasRenderingContext2D;

  constructor(ctx: CanvasRenderingContext2D) {
    this.ctx = ctx;
  }

  /**
   * Render a complete frame.
   *
   * @param source       Source image (ImageBitmap, HTMLImageElement, HTMLCanvasElement, etc.)
   * @param instructions Render instructions from the Compositor
   * @param background   Background configuration
   */
  renderFrame(
    source: CanvasImageSource,
    instructions: RenderInstructions,
    background: BackgroundConfig,
  ): void {
    const { ctx } = this;
    const { outputSize } = instructions;

    // 1. Clear + draw background
    ctx.clearRect(0, 0, outputSize.width, outputSize.height);
    this.drawBackground(outputSize, background);

    // 2. Draw device frame (if present)
    if (instructions.deviceFrame) {
      this.drawDeviceFrame(instructions);
    }

    // 3. Draw source content (clipped to content region)
    this.drawContent(source, instructions);

    // 4. Draw cursor overlay
    if (instructions.cursor.visible) {
      this.drawCursor(instructions);
    }
  }

  /**
   * Draw the background (gradient, solid, or blur).
   */
  private drawBackground(size: Size, config: BackgroundConfig): void {
    const { ctx } = this;

    switch (config.type) {
      case "gradient": {
        const colors = config.colors ?? ["#1a1a2e", "#16213e"];
        const angle = ((config.angle ?? 135) * Math.PI) / 180;
        const cx = size.width / 2;
        const cy = size.height / 2;
        const len = Math.sqrt(size.width ** 2 + size.height ** 2) / 2;

        const gradient = ctx.createLinearGradient(
          cx - Math.cos(angle) * len,
          cy - Math.sin(angle) * len,
          cx + Math.cos(angle) * len,
          cy + Math.sin(angle) * len,
        );
        gradient.addColorStop(0, colors[0]);
        gradient.addColorStop(1, colors[1]);
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, size.width, size.height);
        break;
      }
      case "solid": {
        const colors = config.colors ?? ["#1a1a2e", "#1a1a2e"];
        ctx.fillStyle = colors[0];
        ctx.fillRect(0, 0, size.width, size.height);
        break;
      }
      case "blur": {
        // Blur effect requires drawing the source first then blurring.
        // For now, fall back to solid dark background.
        ctx.fillStyle = "#0a0a14";
        ctx.fillRect(0, 0, size.width, size.height);
        break;
      }
    }
  }

  /**
   * Draw the device frame chrome (title bar, rounded corners, shadow).
   */
  private drawDeviceFrame(instructions: RenderInstructions): void {
    const { ctx } = this;
    const frame = instructions.deviceFrame!;
    const { outer, titleBarHeight, cornerRadius, title } = frame;

    // Drop shadow
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.3)";
    ctx.shadowBlur = 30;
    ctx.shadowOffsetY = 10;

    // Outer frame (rounded rect)
    this.roundRect(outer.dx, outer.dy, outer.dw, outer.dh, cornerRadius);
    ctx.fillStyle = FRAME_BG_COLOR;
    ctx.fill();
    ctx.restore();

    // Title bar
    if (titleBarHeight > 0) {
      ctx.save();
      // Title bar background
      this.roundRectTop(
        outer.dx,
        outer.dy,
        outer.dw,
        titleBarHeight,
        cornerRadius,
      );
      ctx.fillStyle = TITLE_BAR_COLOR;
      ctx.fill();

      // Traffic lights
      const dotY = outer.dy + titleBarHeight / 2;
      const dotStartX = outer.dx + 16;
      const dotRadius = 6;
      const dotGap = 20;

      const dots = [
        { color: TRAFFIC_LIGHT_CLOSE, x: dotStartX },
        { color: TRAFFIC_LIGHT_MINIMIZE, x: dotStartX + dotGap },
        { color: TRAFFIC_LIGHT_MAXIMIZE, x: dotStartX + dotGap * 2 },
      ];

      for (const dot of dots) {
        ctx.beginPath();
        ctx.arc(dot.x, dotY, dotRadius, 0, Math.PI * 2);
        ctx.fillStyle = dot.color;
        ctx.fill();
      }

      // Title text
      if (title) {
        ctx.fillStyle = "#a0a0a0";
        ctx.font = "13px -apple-system, BlinkMacSystemFont, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const maxWidth = outer.dw - 160;
        const titleText =
          title.length > 80 ? title.slice(0, 77) + "..." : title;
        ctx.fillText(titleText, outer.dx + outer.dw / 2, dotY, maxWidth);
      }

      ctx.restore();
    }
  }

  /**
   * Draw the source content (zoomed/cropped region).
   */
  private drawContent(
    source: CanvasImageSource,
    instructions: RenderInstructions,
  ): void {
    const { ctx } = this;
    const { source: src, content } = instructions;
    const frame = instructions.deviceFrame;

    ctx.save();

    // Clip to content region (with rounded corners at bottom if frame exists)
    if (frame) {
      const cr = frame.cornerRadius;
      this.roundRectBottom(
        content.dx,
        content.dy,
        content.dw,
        content.dh,
        cr,
      );
      ctx.clip();
    }

    // Draw source → content
    ctx.drawImage(
      source,
      src.sx,
      src.sy,
      src.sw,
      src.sh,
      content.dx,
      content.dy,
      content.dw,
      content.dh,
    );

    ctx.restore();
  }

  /**
   * Draw cursor with spotlight glow, dual-ring click ripple, and macOS arrow.
   *
   * Drawing order (back to front):
   * 1. Spotlight glow — radial gradient, semi-transparent
   * 2. Primary click ripple (ring 1) — 220ms, blue stroke + glow
   * 3. Secondary click ripple (ring 2) — staggered 80ms, softer/wider
   * 4. Cursor arrow — macOS-style white arrow with dark outline
   */
  private drawCursor(instructions: RenderInstructions): void {
    const { ctx } = this;
    const { cursor } = instructions;

    // 1. Spotlight glow
    if (cursor.spotlight.active) {
      ctx.save();
      const gradient = ctx.createRadialGradient(
        cursor.x, cursor.y, 0,
        cursor.x, cursor.y, cursor.spotlight.radius,
      );
      gradient.addColorStop(0, cursor.spotlight.color);
      gradient.addColorStop(1, "rgba(58, 150, 221, 0)");
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(cursor.x, cursor.y, cursor.spotlight.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // 2 & 3. Click ripple rings
    if (cursor.ripple.active && cursor.ripple.progress > 0) {
      const progress = cursor.ripple.progress;
      const baseSize = 28 * (cursor.size / 24);

      // Ring 1 (primary): 0–220ms of a 400ms total → progress 0–0.55
      const ring1End = 0.55; // 220ms / 400ms
      if (progress < ring1End) {
        const t1 = progress / ring1End;
        // Smoothstep-weighted easing (fast start): t * (3 - 2t) biased
        const ease1 = t1 * (2.0 - t1);
        const scale1 = 0.7 + ease1 * (1.5 - 0.7);
        const radius1 = (baseSize / 2) * scale1;
        const opacity1 = 1 - t1;

        ctx.save();
        // Glow behind ring
        ctx.beginPath();
        ctx.arc(cursor.x, cursor.y, radius1, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(58, 150, 221, ${opacity1 * 0.4})`;
        ctx.lineWidth = 4;
        ctx.stroke();
        // Sharp ring
        ctx.beginPath();
        ctx.arc(cursor.x, cursor.y, radius1, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(58, 150, 221, ${opacity1})`;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.restore();
      }

      // Ring 2 (secondary echo): starts at 80ms → progress 0.2, duration 320ms → ends at 1.0
      if (cursor.dualRipple) {
        const ring2Start = 0.2; // 80ms / 400ms
        if (progress > ring2Start) {
          const ring2Duration = 0.8; // 320ms / 400ms
          const t2 = Math.min((progress - ring2Start) / ring2Duration, 1);
          const ease2 = t2 * (2.0 - t2);
          const scale2 = 0.85 + ease2 * (2.2 - 0.85);
          const radius2 = (baseSize / 2) * scale2;
          const opacity2 = 0.7 * (1 - t2);

          ctx.save();
          ctx.beginPath();
          ctx.arc(cursor.x, cursor.y, radius2, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(58, 150, 221, ${opacity2 * 0.45})`;
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.restore();
        }
      }
    }

    // 4. Cursor arrow (macOS-style)
    this.drawCursorArrow(cursor.x, cursor.y, cursor.size);
  }

  /**
   * Draw a macOS-style arrow cursor (white fill, dark outline).
   * The tip of the arrow is at (x, y), pointing down-right.
   */
  private drawCursorArrow(x: number, y: number, size: number): void {
    const { ctx } = this;
    const s = size / 24; // Scale factor (base design is 24px)

    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s, s);

    ctx.beginPath();
    // Arrow shape: tip at origin, pointing down-right
    ctx.moveTo(0, 0);
    ctx.lineTo(0, 17);
    ctx.lineTo(4.5, 13);
    ctx.lineTo(8, 20);
    ctx.lineTo(11, 18.5);
    ctx.lineTo(7.5, 12);
    ctx.lineTo(12, 12);
    ctx.closePath();

    // Black outline
    ctx.strokeStyle = "rgba(0, 0, 0, 0.9)";
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    ctx.stroke();

    // White fill
    ctx.fillStyle = "#ffffff";
    ctx.fill();

    ctx.restore();
  }

  // -- Canvas path helpers --

  private roundRect(
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
  ): void {
    const { ctx } = this;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  private roundRectTop(
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
  ): void {
    const { ctx } = this;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  private roundRectBottom(
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
  ): void {
    const { ctx } = this;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y);
    ctx.closePath();
  }
}
