/**
 * Paints rendition frames with Skia (@napi-rs/canvas).
 *
 * Source frames arrive as JPEG and decode on libuv's pool (`loadImage`;
 * assigning `Image.src` does not decode in time to draw);
 * drawing is recorded lazily and rasterized when `encode()` is called, which
 * then compresses off-thread. Measured at 1080p: ~5.5 ms of main-thread time
 * and ~14 ms wall per frame. Uploading raw pixels with putImageData instead
 * costs 25–30 ms of main-thread time per frame — too much for a host process
 * that also serves an app.
 */
import type { Camera } from "../direct/shots.js";
import type { BackgroundStyle, CursorStyle } from "../direct/presets.js";
import type { CursorFrame, TouchFrame } from "../direct/cursor.js";
import { ScreenStudioError } from "../errors.js";
import type { Size } from "../util/units.js";
import { POINTERS, type PointerAsset } from "./cursors.js";
import type { Box, Layout } from "./layout.js";

type CanvasModule = typeof import("@napi-rs/canvas");
type Canvas = import("@napi-rs/canvas").Canvas;
type Context = import("@napi-rs/canvas").SKRSContext2D;

let canvasModule: Promise<CanvasModule | null> | null = null;

export function loadCanvas(): Promise<CanvasModule | null> {
  canvasModule ??= import("@napi-rs/canvas").then(
    (mod) => ((mod as { default?: CanvasModule }).default ?? mod) as CanvasModule,
    () => null
  );
  return canvasModule;
}

export interface PainterOptions {
  layout: Layout;
  /** Size of the decoded frames handed to `paint`. */
  frameSize: Size;
  /** Media pixel size; cameras and cursors are in this space. */
  mediaSize: Size;
  background: BackgroundStyle | null;
  title?: string;
  cursor: Exclude<CursorStyle, "touch" | "none"> | "touch" | "none";
  /** Pointer height in output pixels. */
  pointerSize: number;
  rippleMs: number;
}

export class FramePainter {
  /** Two surfaces, so one frame can paint while the previous one compresses. */
  private readonly surfaces: Array<{ canvas: Canvas; ctx: Context; busy: Promise<unknown> }>;
  private next = 0;
  private readonly backdrop: Canvas;
  private readonly pointer: {
    asset: PointerAsset;
    path: InstanceType<CanvasModule["Path2D"]>;
  } | null;
  private readonly mod: CanvasModule;

  private constructor(
    mod: CanvasModule,
    private readonly options: PainterOptions
  ) {
    this.mod = mod;
    const { output } = options.layout;
    this.surfaces = [0, 1].map(() => {
      const canvas = mod.createCanvas(output.width, output.height);
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = true;
      // "high" (cubic) is ~9x slower in Skia and indistinguishable on screen content.
      ctx.imageSmoothingQuality = "medium";
      return { canvas, ctx, busy: Promise.resolve() as Promise<unknown> };
    });
    this.backdrop = mod.createCanvas(output.width, output.height);
    this.paintBackdrop(this.backdrop.getContext("2d"));
    const asset =
      options.cursor === "cua" || options.cursor === "arrow" ? POINTERS[options.cursor] : null;
    this.pointer = asset ? { asset, path: new mod.Path2D(asset.path) } : null;
  }

  static async create(options: PainterOptions): Promise<FramePainter> {
    const mod = await loadCanvas();
    if (!mod) {
      throw new ScreenStudioError("render_failed", "@napi-rs/canvas is not available", {
        hint: "Install it (bun add @napi-rs/canvas) or render with --plain for an FFmpeg-only export.",
      });
    }
    return new FramePainter(mod, options);
  }

  /**
   * Paint one frame and encode it as JPEG off the main thread. Up to two
   * calls may be in flight; results resolve in call order.
   */
  async render(
    jpeg: Buffer,
    camera: Camera,
    pointer: CursorFrame | null,
    touch: TouchFrame | null
  ): Promise<Buffer> {
    const surface = this.surfaces[this.next];
    this.next = (this.next + 1) % this.surfaces.length;
    const previous = surface.busy;
    let release!: () => void;
    surface.busy = new Promise<void>((resolve) => (release = resolve));
    try {
      const [image] = await Promise.all([this.mod.loadImage(jpeg), previous]);
      this.paint(surface.ctx, image, camera, pointer, touch);
      return await surface.canvas.encode("jpeg", 94);
    } finally {
      release();
    }
  }

  private paint(
    ctx: Context,
    image: Awaited<ReturnType<CanvasModule["loadImage"]>>,
    camera: Camera,
    pointer: CursorFrame | null,
    touch: TouchFrame | null
  ): void {
    const { layout, frameSize, mediaSize } = this.options;
    const { content } = layout;
    ctx.drawImage(this.backdrop, 0, 0);
    const viewW = mediaSize.width / camera.zoom;
    const viewH = mediaSize.height / camera.zoom;
    const left = camera.x - viewW / 2;
    const top = camera.y - viewH / 2;
    const sx = frameSize.width / mediaSize.width;
    const sy = frameSize.height / mediaSize.height;

    ctx.save();
    roundedRect(ctx, content, content.radius, content.squareTop);
    ctx.clip();
    ctx.drawImage(
      image,
      left * sx,
      top * sy,
      viewW * sx,
      viewH * sy,
      content.x,
      content.y,
      content.width,
      content.height
    );
    const toOutput = (x: number, y: number) => ({
      x: content.x + ((x - left) / viewW) * content.width,
      y: content.y + ((y - top) / viewH) * content.height,
    });
    if (touch) this.paintTouch(ctx, toOutput(touch.x, touch.y), touch);
    if (pointer && this.pointer) this.paintPointer(ctx, toOutput(pointer.x, pointer.y), pointer);
    ctx.restore();
  }

  private paintPointer(ctx: Context, at: { x: number; y: number }, frame: CursorFrame): void {
    const { unit } = this.options.layout;
    const { asset, path } = this.pointer!;
    ctx.save();
    ctx.globalAlpha = frame.opacity;
    if (frame.rippleAgeMs !== null) {
      const p = Math.min(1, frame.rippleAgeMs / this.options.rippleMs);
      const eased = 1 - (1 - p) ** 3;
      const radius = (10 + 22 * eased) * unit;
      ctx.globalAlpha = frame.opacity * (1 - p) * 0.8;
      ctx.beginPath();
      ctx.arc(at.x, at.y, radius, 0, Math.PI * 2);
      ctx.lineWidth = 3.5 * unit;
      ctx.strokeStyle = "rgba(0, 0, 0, 0.45)";
      ctx.stroke();
      ctx.lineWidth = 1.8 * unit;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
      ctx.stroke();
      ctx.globalAlpha = frame.opacity;
    }
    const scale = (this.options.pointerSize / asset.viewBox.height) * frame.scale;
    ctx.translate(at.x, at.y);
    ctx.scale(scale, scale);
    ctx.translate(-asset.hotspot.x, -asset.hotspot.y);
    ctx.lineJoin = "round";
    ctx.shadowColor = "rgba(8, 12, 22, 0.45)";
    ctx.shadowBlur = (7 * unit) / scale;
    ctx.shadowOffsetY = (2 * unit) / scale;
    ctx.lineWidth = asset.strokeWidth;
    ctx.strokeStyle = asset.stroke;
    ctx.stroke(path);
    ctx.shadowColor = "transparent";
    ctx.fillStyle = asset.fill;
    ctx.fill(path);
    ctx.restore();
  }

  private paintTouch(ctx: Context, at: { x: number; y: number }, frame: TouchFrame): void {
    const { unit } = this.options.layout;
    const radius = 26 * unit * (frame.pressed ? 0.86 : 1);
    ctx.save();
    ctx.globalAlpha = frame.opacity;
    ctx.beginPath();
    ctx.arc(at.x, at.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 255, 255, 0.32)";
    ctx.shadowColor = "rgba(0, 0, 0, 0.3)";
    ctx.shadowBlur = 8 * unit;
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.lineWidth = 2.5 * unit;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.92)";
    ctx.stroke();
    ctx.restore();
  }

  private paintBackdrop(ctx: Context): void {
    const { layout, background, title } = this.options;
    const { output, outer, unit } = layout;
    if (background?.type === "gradient") {
      const angle = (background.angle * Math.PI) / 180;
      const cx = output.width / 2;
      const cy = output.height / 2;
      const half =
        (Math.abs(output.width * Math.sin(angle)) + Math.abs(output.height * Math.cos(angle))) / 2;
      const dx = Math.sin(angle) * half;
      const dy = -Math.cos(angle) * half;
      const gradient = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
      gradient.addColorStop(0, background.from);
      gradient.addColorStop(1, background.to);
      ctx.fillStyle = gradient;
    } else {
      ctx.fillStyle = background?.type === "solid" ? background.color : "#000000";
    }
    ctx.fillRect(0, 0, output.width, output.height);
    if (!outer) return;

    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.42)";
    ctx.shadowBlur = 60 * unit;
    ctx.shadowOffsetY = 24 * unit;
    roundedRect(ctx, outer, outer.radius);
    ctx.fillStyle = layout.frame === "device" ? "#0b0b0d" : "#1c1f26";
    ctx.fill();
    ctx.restore();

    if (layout.frame === "device") {
      roundedRect(ctx, outer, outer.radius);
      ctx.lineWidth = 1.5 * unit;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.14)";
      ctx.stroke();
    }
    if (layout.titleBar > 0) {
      const barY = outer.y + layout.titleBar / 2;
      ["#ff5f57", "#febc2e", "#28c840"].forEach((color, i) => {
        ctx.beginPath();
        ctx.arc(outer.x + (22 + i * 20) * unit, barY, 6.5 * unit, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      });
      ctx.fillStyle = "rgba(255, 255, 255, 0.06)";
      ctx.fillRect(outer.x, outer.y + layout.titleBar - unit, outer.width, unit);
      if (layout.frame === "browser") {
        const pillW = Math.min(620 * unit, outer.width * 0.46);
        const pill = {
          x: outer.x + (outer.width - pillW) / 2,
          y: barY - 13 * unit,
          width: pillW,
          height: 26 * unit,
        };
        roundedRect(ctx, pill, 8 * unit);
        ctx.fillStyle = "rgba(255, 255, 255, 0.07)";
        ctx.fill();
      }
      if (title) {
        ctx.fillStyle = "#9aa3b2";
        ctx.font = `${Math.round(14 * unit)}px -apple-system, "SF Pro Text", "Helvetica Neue", Arial, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const max =
          layout.frame === "browser"
            ? Math.min(600 * unit, outer.width * 0.44)
            : outer.width - 160 * unit;
        ctx.fillText(ellipsize(ctx, title, max), outer.x + outer.width / 2, barY + unit);
      }
    }
  }
}

function ellipsize(ctx: Context, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > max) cut = cut.slice(0, -1);
  return `${cut}…`;
}

function roundedRect(ctx: Context, box: Box, radius: number, squareTop = false): void {
  const r = Math.max(0, Math.min(radius, box.width / 2, box.height / 2));
  const top = squareTop ? 0 : r;
  ctx.beginPath();
  ctx.moveTo(box.x + top, box.y);
  ctx.lineTo(box.x + box.width - top, box.y);
  ctx.arcTo(box.x + box.width, box.y, box.x + box.width, box.y + top, top);
  ctx.lineTo(box.x + box.width, box.y + box.height - r);
  ctx.arcTo(box.x + box.width, box.y + box.height, box.x + box.width - r, box.y + box.height, r);
  ctx.lineTo(box.x + r, box.y + box.height);
  ctx.arcTo(box.x, box.y + box.height, box.x, box.y + box.height - r, r);
  ctx.lineTo(box.x, box.y + top);
  ctx.arcTo(box.x, box.y, box.x + top, box.y, top);
  ctx.closePath();
}
