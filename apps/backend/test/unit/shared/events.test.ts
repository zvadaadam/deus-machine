import { describe, expect, it } from "vitest";
import {
  BACKEND_PORT_CHANGED,
  WORKSPACE_PROGRESS,
  BROWSER_NEW_TAB_REQUESTED,
  AppEventSchemaMap,
  WorkspaceProgressSchema,
} from "@shared/events";

describe("shared/events", () => {
  it("has a schema for every desktop event, and no others", () => {
    expect(Object.keys(AppEventSchemaMap).sort()).toEqual(
      [BACKEND_PORT_CHANGED, WORKSPACE_PROGRESS, BROWSER_NEW_TAB_REQUESTED].sort()
    );
  });

  it("accepts a workspace's progress", () => {
    const result = WorkspaceProgressSchema.safeParse({
      workspaceId: "ws-1",
      step: "dependencies",
      label: "Installing deps...",
    });
    expect(result.success).toBe(true);
  });

  it("refuses a progress event with fields missing", () => {
    expect(WorkspaceProgressSchema.safeParse({ workspaceId: "ws-1" }).success).toBe(false);
  });
});
