import { expect, it } from "vitest";
import { beforeBreadcrumb } from "@shared/lib/sentry-breadcrumb";

it("drops console and UI breadcrumbs and keeps the others", () => {
  expect(beforeBreadcrumb({ category: "console" })).toBeNull();
  expect(beforeBreadcrumb({ category: "ui.click" })).toBeNull();
  const request = { category: "http", message: "Request completed" };
  expect(beforeBreadcrumb(request)).toBe(request);
  const uncategorized = { message: "Started" };
  expect(beforeBreadcrumb(uncategorized)).toBe(uncategorized);
});
