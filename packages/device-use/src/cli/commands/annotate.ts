import { Jimp } from "jimp";
import type { Frame, RefEntry } from "../../engine/types.js";

/**
 * Draw colored rectangles around each ref on top of a screenshot.
 * Returns the box positions (in pixel space) so a caller can render a legend.
 *
 * Simulator screenshots are in physical pixels (e.g. 1206×2622) while
 * accessibility frames are in logical points (402×874). We auto-detect the
 * scale factor from the widest visible ref and apply it uniformly.
 */

export interface AnnotationBox {
  ref: string;
  type: string;
  label?: string;
  /** Pixel-space bounding box — fields match engine's `Frame` shape. */
  pixel: { x: number; y: number; width: number; height: number };
  color: string; // hex, e.g. "#00FF88"
}

export interface AnnotateResult {
  width: number;
  height: number;
  scale: number;
  boxes: AnnotationBox[];
}

// Rotating palette keeps adjacent boxes distinguishable.
const PALETTE_RGBA = [0x00ff88ff, 0xff5577ff, 0x55aaffff, 0xffdd33ff, 0xaa55ffff, 0x22ddccff];
const PALETTE_HEX = ["#00FF88", "#FF5577", "#55AAFF", "#FFDD33", "#AA55FF", "#22DDCC"];

const STROKE_WIDTH = 3;

export async function annotateScreenshot(
  pngPath: string,
  refs: RefEntry[],
  outputPath: string
): Promise<AnnotateResult> {
  const img = await Jimp.read(pngPath);

  const scale = scaleFactor(img, refs);
  const boxes: AnnotationBox[] = [];

  let i = 0;
  for (const r of refs) {
    const px = mapFrame(r.frame, scale);
    if (!inBounds(px, img.width, img.height)) continue;

    const rgba = PALETTE_RGBA[i % PALETTE_RGBA.length]!;
    const hex = PALETTE_HEX[i % PALETTE_HEX.length]!;
    drawRect(img, px, rgba);
    drawCornerTag(img, px, rgba);

    boxes.push({
      ref: r.ref,
      type: r.type,
      label: r.label,
      pixel: { x: px.x, y: px.y, width: px.w, height: px.h },
      color: hex,
    });
    i++;
  }

  await img.write(outputPath as `${string}.${string}`);
  return { width: img.width, height: img.height, scale, boxes };
}

function scaleFactor(img: { width: number; height: number }, refs: RefEntry[]): number {
  let maxRight = 0;
  for (const r of refs) maxRight = Math.max(maxRight, r.frame.x + r.frame.width);
  if (maxRight > 0 && img.width > 0) return img.width / maxRight;
  return 1;
}

interface PxFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}

function mapFrame(f: Frame, scale: number): PxFrame {
  return {
    x: Math.round(f.x * scale),
    y: Math.round(f.y * scale),
    w: Math.round(f.width * scale),
    h: Math.round(f.height * scale),
  };
}

function inBounds(px: PxFrame, imgW: number, imgH: number): boolean {
  return px.x >= 0 && px.y >= 0 && px.x < imgW && px.y < imgH && px.w > 0 && px.h > 0;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type JimpImg = any;

function drawRect(img: JimpImg, px: PxFrame, rgba: number): void {
  const { x, y, w, h } = px;
  for (let s = 0; s < STROKE_WIDTH; s++) {
    drawLine(img, x + s, y + s, x + w - s, y + s, rgba); // top
    drawLine(img, x + s, y + h - s, x + w - s, y + h - s, rgba); // bottom
    drawLine(img, x + s, y + s, x + s, y + h - s, rgba); // left
    drawLine(img, x + w - s, y + s, x + w - s, y + h - s, rgba); // right
  }
}

/** Small filled square in the top-left of each box to reinforce the color. */
function drawCornerTag(img: JimpImg, px: PxFrame, rgba: number): void {
  const size = 16;
  const x0 = px.x;
  const y0 = px.y;
  for (let y = y0; y < y0 + size; y++) {
    for (let x = x0; x < x0 + size; x++) {
      setPixel(img, x, y, rgba);
    }
  }
}

function drawLine(
  img: JimpImg,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  rgba: number
): void {
  if (y1 === y2) {
    for (let x = x1; x <= x2; x++) setPixel(img, x, y1, rgba);
  } else {
    for (let y = y1; y <= y2; y++) setPixel(img, x1, y, rgba);
  }
}

function setPixel(img: JimpImg, x: number, y: number, rgba: number): void {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  img.setPixelColor(rgba, x, y);
}
