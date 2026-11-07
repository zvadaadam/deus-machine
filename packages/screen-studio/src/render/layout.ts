import type { SourceKind } from "../bundle/schema.js";
import type { FrameStyle } from "../direct/presets.js";
import type { Size } from "../util/units.js";

export type ResolvedFrame = Exclude<FrameStyle, "auto">;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Layout {
  output: Size;
  /** 1 at 1080p; every chrome dimension scales with it. */
  unit: number;
  frame: ResolvedFrame;
  /** Window or bezel outline; null without a frame. */
  outer: (Box & { radius: number }) | null;
  titleBar: number;
  /** Where the (cropped) source is drawn. Always the source's aspect ratio. */
  content: Box & { radius: number; squareTop: boolean };
}

export function resolveFrame(
  style: FrameStyle,
  kind: SourceKind,
  hasBackground: boolean
): ResolvedFrame {
  if (!hasBackground) return "none";
  if (style !== "auto") return style;
  switch (kind) {
    case "browser":
      return "browser";
    case "ios-simulator":
      return "device";
    case "test-pattern":
      return "window";
    default:
      return "rounded";
  }
}

const DEVICE_BEZEL = 0.03;

export function computeLayout(output: Size, source: Size, frame: ResolvedFrame): Layout {
  const unit = Math.min(output.width / 1920, output.height / 1080);
  const aspect = source.width / source.height;
  if (frame === "none") {
    const width = Math.min(output.width, output.height * aspect);
    const height = width / aspect;
    return {
      output,
      unit,
      frame,
      outer: null,
      titleBar: 0,
      content: {
        x: (output.width - width) / 2,
        y: (output.height - height) / 2,
        width,
        height,
        radius: 0,
        squareTop: false,
      },
    };
  }

  const portrait = aspect < 1;
  const availW = output.width * (1 - 2 * 0.07);
  const availH = output.height * (1 - 2 * (portrait ? 0.05 : 0.08));
  const titleBar =
    frame === "browser" ? Math.round(44 * unit) : frame === "window" ? Math.round(34 * unit) : 0;

  let cw: number;
  if (frame === "device") {
    cw = Math.min(availW / (1 + 2 * DEVICE_BEZEL), availH / (1 / aspect + 2 * DEVICE_BEZEL));
  } else {
    cw = Math.min(availW, (availH - titleBar) * aspect);
  }
  const ch = cw / aspect;
  const bezel = frame === "device" ? Math.round(cw * DEVICE_BEZEL) : 0;
  const outerW = cw + bezel * 2;
  const outerH = ch + bezel * 2 + titleBar;
  const ox = (output.width - outerW) / 2;
  const oy = (output.height - outerH) / 2;

  const windowRadius = Math.round(12 * unit);
  const screenRadius =
    frame === "device"
      ? Math.round(cw * 0.13)
      : frame === "rounded"
        ? Math.round(14 * unit)
        : windowRadius;
  return {
    output,
    unit,
    frame,
    outer: {
      x: ox,
      y: oy,
      width: outerW,
      height: outerH,
      radius:
        frame === "device"
          ? screenRadius + bezel
          : frame === "rounded"
            ? screenRadius
            : windowRadius,
    },
    titleBar,
    content: {
      x: ox + bezel,
      y: oy + bezel + titleBar,
      width: cw,
      height: ch,
      radius: screenRadius,
      squareTop: titleBar > 0,
    },
  };
}
