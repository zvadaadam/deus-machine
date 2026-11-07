/**
 * Pointer artwork. Each asset declares its view box and hotspot explicitly so
 * the tip lands exactly on the action target at any size.
 */
export interface PointerAsset {
  id: string;
  /** SVG path data. */
  path: string;
  viewBox: { x: number; y: number; width: number; height: number };
  hotspot: { x: number; y: number };
  fill: string;
  stroke: string;
  strokeWidth: number;
  attribution?: string;
}

export const POINTERS: Record<"cua" | "arrow", PointerAsset> = {
  /**
   * The rounded Cua driver pointer, recolored black with a white outline.
   * MIT License, Copyright (c) 2025 Cua AI, Inc. — github.com/trycua/cua @ 67b86c9b,
   * apps/cua-spaces-macos/scripts/dmg-art/src/cua-driver-cursor.svg
   */
  cua: {
    id: "cua",
    path:
      "M55 30 C48 28 42 33 43 41 C43 41 64 98 64 98 C67 106 73 106 77 99 C77 99 86 79 86 79 " +
      "C88 75 91 72 95 70 C95 70 108 63 108 63 C115 59 114 53 107 50 C107 50 55 30 55 30 Z",
    viewBox: { x: 36, y: 24, width: 80, height: 80 },
    // The apex of the rounded tip (the first curve at t = 0.5), not the path start.
    hotspot: { x: 46.5, y: 32.5 },
    fill: "#000000",
    stroke: "#ffffff",
    strokeWidth: 5,
    attribution: "Cua driver cursor, MIT License, Copyright (c) 2025 Cua AI, Inc.",
  },
  /** A classic system-style arrow. */
  arrow: {
    id: "arrow",
    path: "M0 0 L0 17 L4.5 13 L8 20 L11 18.5 L7.5 12 L12 12 Z",
    viewBox: { x: -2, y: -2, width: 16, height: 24 },
    hotspot: { x: 0, y: 0 },
    fill: "#ffffff",
    stroke: "#111111",
    strokeWidth: 1.4,
  },
};
