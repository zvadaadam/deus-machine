/** Shared easing constants for animations across the app. */

/** Ease-out-quart as a tuple — use with Framer Motion `transition.ease`. */
export const EASE_OUT_QUART: [number, number, number, number] = [0.165, 0.84, 0.44, 1];

/** Ease-out-quart as a CSS `cubic-bezier()` string — use with inline CSS `transition`. */
export const EASE_OUT_QUART_CSS = "cubic-bezier(0.165, 0.84, 0.44, 1)";
