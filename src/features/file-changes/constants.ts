/**
 * File Changes Feature Constants
 * Named constants for magic numbers and configuration
 */

/**
 * Diff viewer settings
 */
export const DIFF_VIEWER = {
  /** Maximum line length for word-level diff highlighting */
  MAX_LINE_LENGTH_FOR_WORD_DIFF: 200,
  /** Maximum word diff ranges before skipping (too many = not useful) */
  MAX_WORD_DIFF_RANGES: 10,
  /** Copy feedback duration in milliseconds */
  COPY_FEEDBACK_DURATION_MS: 2000,
} as const;

/**
 * File tree settings
 */
export const FILE_TREE = {
  /** Auto-expand ALL folders by default (Infinity = unlimited depth) */
  AUTO_EXPAND_DEPTH: Infinity,
  /** Indent size per level in pixels */
  INDENT_SIZE_PX: 16,
} as const;

/**
 * Scroll spy settings
 */
export const SCROLL_SPY = {
  /** Root margin for IntersectionObserver (determines when section is "active") */
  ROOT_MARGIN: "-10% 0px -80% 0px",
  /** Threshold for intersection detection */
  THRESHOLD: 0,
} as const;

/**
 * Animation settings
 */
export const ANIMATION = {
  /** Panel transition duration in milliseconds */
  PANEL_TRANSITION_MS: 300,
  /** Smooth scroll behavior */
  SCROLL_BEHAVIOR: "smooth" as const,
} as const;
