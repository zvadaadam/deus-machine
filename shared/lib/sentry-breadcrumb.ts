import type { Breadcrumb } from "@sentry/node";

export function beforeBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  const { category } = breadcrumb;
  return category === "console" || category?.startsWith("ui.") ? null : breadcrumb;
}
