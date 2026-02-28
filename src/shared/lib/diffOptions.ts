import { useMemo } from "react";
import { useTheme } from "@/app/providers";
import { useSettings } from "@/features/settings/api/settings.queries";
import type { PatchDiffProps } from "@pierre/diffs/react";

type DiffOptions<LAnnotation = undefined> = NonNullable<PatchDiffProps<LAnnotation>["options"]>;

const DIFF_LIMITS = {
  maxLineDiffLength: 1000, // Match Codex — process longer lines for word-level diffs
  tokenizeMaxLineLength: 1000,
} as const;

const DIFF_CONTEXT = {
  collapsedContextThreshold: 6,
  expansionLineCount: 100, // Match Codex — load context in smaller chunks
} as const;

const DIFF_UNSAFE_CSS = `
  [data-diffs-header],
  [data-diffs] {
    --diffs-dark-bg: var(--background) !important;
    --diffs-light-bg: var(--background) !important;
    --diffs-dark: var(--foreground) !important;
    --diffs-light: var(--foreground) !important;
    --diffs-bg-context-override: var(--background) !important;
    --diffs-bg-separator-override: transparent !important;
    --diffs-bg-buffer-override: transparent !important;
    background-color: var(--background) !important;
  }
  [data-diffs-header] {
    position: sticky;
    top: 0;
    z-index: 4;
    min-height: 34px;
    padding-inline: 12px;
    background: var(--bg-elevated, var(--background));
    border-bottom: none;
    box-shadow: 0 1px 0 color-mix(in oklch, var(--foreground) 6%, transparent);
  }
  [data-header-content] {
    font-size: 12px;
    font-weight: 500;
  }
  [data-metadata] [data-additions-count],
  [data-metadata] [data-deletions-count] {
    display: none !important;
  }
  [data-separator='line-info'] {
    background: transparent;
  }
  [data-separator-wrapper] {
    position: relative;
    cursor: pointer;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }
  [data-line],
  [data-column-number],
  [data-column-content] {
    transition: none !important;
  }
  [data-separator-wrapper]:hover {
    background: color-mix(in lab, var(--foreground) 6%, var(--background));
    border-color: color-mix(in lab, var(--foreground) 16%, var(--border));
  }
  [data-separator-wrapper]:hover [data-separator-content],
  [data-separator-wrapper]:hover [data-expand-button] {
    opacity: 0.9;
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
  [data-separator-content],
  [data-expand-button] {
    background: transparent;
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
