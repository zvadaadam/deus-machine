/**
 * Re-export of the workspace tab registry for layout consumers and tests.
 * Source of truth lives in `@/features/workspace-tabs/registry`.
 */
export {
  CONTENT_TABS,
  TAB_KIND_ICONS,
  tabsFor,
  isTabVisible,
  isWorkspaceTabVisible,
  anyContentTabVisible,
  getVisibleTools,
  type ContentTabItem,
  type ContentTabVisibility,
} from "@/features/workspace-tabs/registry";
