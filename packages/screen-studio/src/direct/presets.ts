import type { PacingMode } from "../edit/pacing.js";
import type { Size } from "../util/units.js";
import type { SpringConfig } from "./spring.js";

export type CursorStyle = "cua" | "arrow" | "dot" | "touch" | "none";
/** `auto` picks per source: browser chrome for tabs, a device bezel for phones. */
export type FrameStyle = "auto" | "browser" | "window" | "device" | "rounded" | "none";

export type BackgroundStyle =
  | { type: "gradient"; from: string; to: string; angle: number }
  | { type: "solid"; color: string };

export interface CameraTokens {
  enabled: boolean;
  maxZoom: number;
  /** Below this, a zoom is not worth the motion: stay wide. */
  minZoom: number;
  /** Space kept around a target, as a fraction of the media height. */
  padding: number;
  /** The camera arrives this long before the action it frames. */
  leadMs: number;
  /** Actions closer than this (and close on screen) share one shot. */
  clusterGapMs: number;
  /** Shorter shots are dropped: a camera that never settles reads as jitter. */
  minShotMs: number;
  /** How long a shot holds after its last action before it may release. */
  settleMs: number;
  /** Return to the full view when the next shot is further away than this. */
  returnAfterMs: number;
  position: SpringConfig;
  zoom: SpringConfig;
}

export interface CursorTokens {
  /** `auto`: pointer for browsers and desktops, touches for phones. */
  style: CursorStyle | "auto";
  /** Pointer height as a fraction of the output height. */
  size: number;
  travelMs: number;
  /** Below this a move is a jump. */
  minTravelMs: number;
  /** The pointer rests on a target this long before the action. */
  dwellMs: number;
  pressMs: number;
  releaseMs: number;
  /** Fade out after this much inactivity, so the pointer does not cover results. */
  hideAfterMs: number;
  fadeMs: number;
  rippleMs: number;
  /** Bow of the travel path, as a fraction of its length. */
  arc: number;
  /** Cubic-bezier control points. */
  travelCurve: [number, number, number, number];
  feedbackCurve: [number, number, number, number];
}

export interface Preset {
  name: string;
  description: string;
  pacing: PacingMode;
  camera: CameraTokens;
  cursor: CursorTokens;
  frame: FrameStyle;
  background: BackgroundStyle | null;
  /** Output size, or the source's own size. */
  output: Size | "source";
  fps: number;
}

export const BACKGROUNDS: Record<string, BackgroundStyle> = {
  midnight: { type: "gradient", from: "#25354d", to: "#111724", angle: 135 },
  dusk: { type: "gradient", from: "#3b2f5c", to: "#141022", angle: 135 },
  paper: { type: "gradient", from: "#eef1f6", to: "#d5dce8", angle: 135 },
  black: { type: "solid", color: "#000000" },
};

const CAMERA: CameraTokens = {
  enabled: true,
  maxZoom: 1.6,
  minZoom: 1.18,
  padding: 0.06,
  leadMs: 650,
  clusterGapMs: 2500,
  minShotMs: 700,
  settleMs: 1500,
  returnAfterMs: 3000,
  position: { omega: 7, zeta: 0.92 },
  zoom: { omega: 6, zeta: 0.96 },
};

const CURSOR: CursorTokens = {
  style: "auto",
  size: 0.045,
  travelMs: 650,
  minTravelMs: 140,
  dwellMs: 110,
  pressMs: 120,
  releaseMs: 200,
  hideAfterMs: 900,
  fadeMs: 220,
  rippleMs: 450,
  arc: 0.08,
  travelCurve: [0.77, 0, 0.175, 1],
  feedbackCurve: [0.23, 1, 0.32, 1],
};

export const PRESETS: Record<string, Preset> = {
  review: {
    name: "review",
    description: "Original timing and framing with action markers. For debugging and review.",
    pacing: "preserve",
    camera: { ...CAMERA, enabled: false },
    cursor: { ...CURSOR, hideAfterMs: 1500 },
    frame: "none",
    background: null,
    output: "source",
    fps: 30,
  },
  replay: {
    name: "replay",
    description: "Waits sped up, nothing added but the pointer. For session replays and audits.",
    pacing: "compress",
    camera: { ...CAMERA, enabled: false },
    cursor: CURSOR,
    frame: "none",
    background: null,
    output: "source",
    fps: 30,
  },
  walkthrough: {
    name: "walkthrough",
    description: "Waits sped up, gentle zoom on actions, framed on a background.",
    pacing: "compress",
    camera: CAMERA,
    cursor: CURSOR,
    frame: "auto",
    background: BACKGROUNDS.midnight,
    output: { width: 1920, height: 1080 },
    fps: 30,
  },
  demo: {
    name: "demo",
    description: "Short and punchy: waits cut, closer zoom. For sharing.",
    pacing: "cut",
    camera: { ...CAMERA, maxZoom: 1.8, minZoom: 1.15 },
    cursor: CURSOR,
    frame: "auto",
    background: BACKGROUNDS.midnight,
    output: { width: 1920, height: 1080 },
    fps: 30,
  },
};

export const DEFAULT_PRESET = "walkthrough";
