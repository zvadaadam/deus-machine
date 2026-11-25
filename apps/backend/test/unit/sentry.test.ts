import { expect, it } from "vitest";
import { beforeBreadcrumb } from "@shared/lib/sentry-breadcrumb";

it("drops console breadcrumbs and keeps other breadcrumbs in error reports", () => {
  expect(beforeBreadcrumb({ category: "console" })).toBeNull();
  const request = { category: "http", message: "Request completed" };
  expect(beforeBreadcrumb(request)).toBe(request);
  const uncategorized = { message: "Started" };
  expect(beforeBreadcrumb(uncategorized)).toBe(uncategorized);
});
