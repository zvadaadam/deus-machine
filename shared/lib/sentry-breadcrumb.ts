import type { Breadcrumb } from "@sentry/node";

export function beforeBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  return breadcrumb.category === "console" ? null : breadcrumb;
}
