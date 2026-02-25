/**
 * Changes filter — shared type and options for the diff filter dropdown.
 *
 * Used by both CodePanelContent (Changes sub-tab) and FileBrowserPanel
 * (standalone Changes mode). Extracting just the data avoids duplicating
 * the type alias and options array while keeping UI rendering independent.
 */

export type ChangesFilter = "all-changes" | "uncommitted" | "last-turn";

export const CHANGES_FILTER_OPTIONS: readonly [ChangesFilter, string][] = [
  ["all-changes", "All changes"],
  ["uncommitted", "Uncommitted"],
  ["last-turn", "Last turn"],
];

/** Human-readable label for the active filter value */
export function changesFilterLabel(filter: ChangesFilter): string {
  const match = CHANGES_FILTER_OPTIONS.find(([v]) => v === filter);
  return match ? match[1] : "All Changes";
}
