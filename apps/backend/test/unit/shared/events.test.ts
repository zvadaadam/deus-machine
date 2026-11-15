import { describe, expect, it } from "vitest";
import { BACKEND_PORT_CHANGED, BROWSER_NEW_TAB_REQUESTED, AppEventSchemaMap } from "@shared/events";

describe("shared/events", () => {
  it("has a schema for every desktop event, and no others", () => {
    expect(Object.keys(AppEventSchemaMap).sort()).toEqual(
      [BACKEND_PORT_CHANGED, BROWSER_NEW_TAB_REQUESTED].sort()
    );
  });
});
