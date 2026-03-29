import { useMemo } from "react";
import { useTheme } from "@/app/providers";
import { useSettings } from "@/features/settings/api/settings.queries";
import type { PatchDiffProps } from "@pierre/diffs/react";

type DiffOptions<LAnnotation = undefined> = NonNullable<PatchDiffProps<LAnnotation>["options"]>;

const DIFF_LIMITS = {
  maxLineDiffLength: 1000, // Process longer lines for word-level diffs
  tokenizeMaxLineLength: 1000,
} as const;

const DIFF_CONTEXT = {
  collapsedContextThreshold: 6,
  expansionLineCount: 100, // Load context in smaller chunks
} as const;

/**
 * Injected into the @pierre/diffs Shadow DOM via the `unsafeCSS` option.
 *
 * RULES:
 *   1. ONLY set CSS variables — never override layout, position, or sizing.
 *      The library's grid handles separator/line positioning; fighting it breaks things.
 *   2. NO !important — the library's --diffs-*-override variables are designed to win
 *      the cascade. Setting them is sufficient; !important fights future library updates.
 *   3. Use var(--our-token) so Shadow DOM inherits from :root.
 */
const DIFF_UNSAFE_CSS = `
  [data-diffs-header] {
    position: sticky;
    top: 0;
    z-index: 4;
    background: var(--bg-elevated, var(--background));
    border-bottom: none;
    box-shadow: 0 1px 0 color-mix(in oklch, var(--foreground) 6%, transparent);
  }
  [data-metadata] [data-additions-count],
  [data-metadata] [data-deletions-count] {
    display: none;
  }
  [data-line],
  [data-column-number],
  [data-column-content] {
    transition: none;
  }

  /* Hunk separator: make the expand button cover the full row so any click expands.
     The built-in "line-info" separator puts a small icon in the gutter; this
     stretches it edge-to-edge and adds a hover highlight. */
  [data-separator-wrapper] {
    position: relative;
    cursor: pointer;
    background: transparent;
  }
  [data-separator-wrapper]:hover {
    background: color-mix(in oklch, var(--diffs-fg, currentColor) 4%, transparent);
  }
  [data-separator-wrapper] [data-expand-button] {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: flex-start;
    padding-left: 10px;
    background: transparent;
    z-index: 2;
  }
  [data-separator-content] {
    pointer-events: none;
    position: relative;
    z-index: 1;
    padding-left: 28px;
  }
`;

export function useDiffOptions<LAnnotation = undefined>(): DiffOptions<LAnnotation> {
  const { actualTheme } = useTheme();
  const { data: settings } = useSettings();

  const diffStyle = settings?.diff_view_mode === "split" ? "split" : "unified";
  const themeType = actualTheme === "dark" ? ("dark" as const) : ("light" as const);

  return useMemo(
    () => ({
      diffStyle,
      lineDiffType: "word-alt" as const,
      diffIndicators: "bars" as const,
      themeType,
      theme: { dark: "github-dark" as const, light: "github-light" as const },
      hunkSeparators: "line-info" as const,
      maxLineDiffLength: DIFF_LIMITS.maxLineDiffLength,
      tokenizeMaxLineLength: DIFF_LIMITS.tokenizeMaxLineLength,
      collapsedContextThreshold: DIFF_CONTEXT.collapsedContextThreshold,
      expansionLineCount: DIFF_CONTEXT.expansionLineCount,
      unsafeCSS: DIFF_UNSAFE_CSS,
    }),
    [diffStyle, themeType]
  );
}
