/**
 * Pierre file-tree theming artifacts.
 *
 * Kept out of FileTree.tsx so the component file stays logic + rendering;
 * presentation lives here next to the Pierre sprite injection (pierreIcons.tsx).
 *
 * `fileTreeThemeStyles` is the CSS custom-property override set applied on
 * Pierre's host element. Pierre reads these at its shadow-DOM boundary.
 */

import type { CSSProperties } from "react";

/**
 * Pierre reads theming from CSS custom properties on the host element.
 * These overrides make the tree inherit our runtime dark/light theme through
 * Pierre's shadow-DOM boundary. Use app CSS variables directly here; Tailwind
 * `--color-*` theme tokens are compile-time aliases and can resolve poorly
 * inside third-party shadow roots.
 */
export const fileTreeThemeStyles: CSSProperties = {
  display: "block",
  height: "100%",
  width: "100%",
  backgroundColor: "var(--bg-elevated)",
  colorScheme: "light dark",
  ["--trees-bg-override" as never]: "var(--bg-elevated)",
  ["--trees-bg-muted-override" as never]: "var(--bg-muted)",
  ["--trees-fg-override" as never]: "var(--text-secondary)",
  ["--trees-border-color-override" as never]: "var(--border-default)",
  ["--trees-input-bg-override" as never]: "var(--bg-elevated)",
  ["--trees-search-bg-override" as never]: "var(--bg-muted)",
  ["--trees-search-fg-override" as never]: "var(--text-primary)",
  ["--trees-selected-bg-override" as never]: "color-mix(in oklab, var(--primary) 14%, transparent)",
  ["--trees-selected-fg-override" as never]: "var(--text-primary)",
};
