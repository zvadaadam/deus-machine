/**
 * Pierre file-tree theming artifacts.
 *
 * Kept out of FileTree.tsx so the component file stays logic + rendering;
 * presentation lives here next to the Pierre sprite injection (pierreIcons.tsx).
 *
 * - `fileTreeThemeStyles` is the CSS custom-property override set applied on
 *   Pierre's host element. Pierre reads these at its shadow-DOM boundary.
 * - `FILE_TREE_FLASH_CSS` is the keyframe + class sheet we inject via Pierre's
 *   `unsafeCSS` option so trading-terminal activity flashes live inside the
 *   shadow root (where the rows are). Uses app-level CSS custom properties
 *   so dark/light themes stay consistent through the shadow boundary.
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

/**
 * Flash keyframes injected into Pierre's shadow root via `unsafeCSS`. App-level
 * CSS custom properties inherit through the shadow boundary, so themes stay
 * consistent. Class names here must stay in sync with KIND_CLASS in FileTree.tsx.
 */
export const FILE_TREE_FLASH_CSS = `
  @keyframes deus-flash-add {
    0%   { background: color-mix(in oklab, var(--color-success) 30%, transparent); }
    35%  { background: color-mix(in oklab, var(--color-success) 10%, transparent); }
    100% { background: transparent; }
  }
  @keyframes deus-flash-edit {
    0%   { background: color-mix(in oklab, var(--color-warning) 30%, transparent); }
    35%  { background: color-mix(in oklab, var(--color-warning) 10%, transparent); }
    100% { background: transparent; }
  }
  @keyframes deus-flash-delete {
    0%   { background: color-mix(in oklab, var(--color-destructive) 30%, transparent); }
    35%  { background: color-mix(in oklab, var(--color-destructive) 10%, transparent); }
    100% { background: transparent; }
  }
  button[data-item-path].deus-flash-add    { animation: deus-flash-add    1600ms ease-out; }
  button[data-item-path].deus-flash-edit   { animation: deus-flash-edit   1600ms ease-out; }
  button[data-item-path].deus-flash-delete { animation: deus-flash-delete 1600ms ease-out; }

  @media (prefers-reduced-motion: reduce) {
    button[data-item-path].deus-flash-add,
    button[data-item-path].deus-flash-edit,
    button[data-item-path].deus-flash-delete {
      animation: none;
      transition: background 1200ms;
    }
  }
`.trim();
