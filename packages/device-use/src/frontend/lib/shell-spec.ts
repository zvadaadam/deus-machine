/** Visual shell spec — bezel dimensions per device class.
 *
 *  The shell's aspect ratio is derived from the stream's point dimensions
 *  (streamInfo.size.ptW/ptH) so the content fills the screen box exactly
 *  regardless of which iPhone/iPad model is pinned. A fixed
 *  `430 / 932` looked wrong on iPhone Air (420×912) and iPhone 17 Pro Max
 *  (440×956). Percentage insets + rem radii scale automatically.
 *
 *  We do NOT draw dynamic island / camera hole overlays — the simulator's
 *  MJPEG stream already includes iOS's native status bar (with its own
 *  cutout). Drawing a second pill on top caused the "two islands stacked"
 *  artifact. The shell is the bezel only; the stream is the screen. */
export interface ShellSpec {
  aspectRatio: string;
  shellRadius: string;
  screenRadius: string;
  screenInsets: { top: string; left: string; right: string; bottom: string };
}

export const PHONE_INSETS = { top: 1.7, left: 2.5, right: 2.5, bottom: 1.9 }; // %
export const TABLET_INSETS = { top: 2.1, left: 2.2, right: 2.2, bottom: 2.1 }; // %

/** Derive the shell's CSS `aspect-ratio` so the percentage-inset screen box
 *  matches the stream's native point aspect ratio exactly.
 *
 *  Geometry (verified against `styles.css`):
 *    .device-shell has inline `aspect-ratio: <shellAR>`   => shellW/shellH = shellAR
 *    .device-screen is absolutely positioned with % insets => screenW = shellW * widthFrac
 *                                                          => screenH = shellH * heightFrac
 *    .device-canvas is width:100%/height:100% with no object-fit, so the
 *    bitmap fills the screen box 1:1 in CSS pixels.
 *
 *  Solving for the shell aspect ratio that makes the screen box match the
 *  stream:
 *    screenW / screenH                         = streamAR
 *    (shellW * widthFrac) / (shellH * heightFrac) = streamAR
 *    (shellW / shellH) * (widthFrac / heightFrac)  = streamAR
 *    shellAR * (widthFrac / heightFrac)           = streamAR
 *    => shellAR = streamAR * (heightFrac / widthFrac)
 *
 *  Note: a sub-perceptual (~0.3% phone / ~0.05% tablet) residual remains
 *  because CSS resolves the screen's % insets against the shell's padding
 *  box (`shellW - 2px`) rather than its border box, thanks to the
 *  `border: 1px` on `.device-shell` + `box-sizing: border-box`. Correcting
 *  that would require substituting padding-box dimensions into both
 *  `shellAR` and the inline inset style and is over-engineering for <0.3%.
 */
export function getShellSpec(
  deviceName: string | null | undefined,
  size: { ptW: number; ptH: number } | undefined
): ShellSpec {
  const isTablet = deviceName?.includes("iPad") ?? false;
  const insets = isTablet ? TABLET_INSETS : PHONE_INSETS;

  const widthFrac = 1 - (insets.left + insets.right) / 100;
  const heightFrac = 1 - (insets.top + insets.bottom) / 100;
  const streamAR = size ? size.ptW / size.ptH : isTablet ? 834 / 1194 : 430 / 932;
  // Invert the inset-compensation ratio so the inner screen box (not the
  // outer shell) lands on the stream's native aspect ratio.
  const shellAR = (streamAR * heightFrac) / widthFrac;

  return {
    aspectRatio: `${shellAR}`,
    shellRadius: isTablet ? "2.75rem" : "3.25rem",
    screenRadius: isTablet ? "2.1rem" : "2.6rem",
    screenInsets: {
      top: `${insets.top}%`,
      left: `${insets.left}%`,
      right: `${insets.right}%`,
      bottom: `${insets.bottom}%`,
    },
  };
}
