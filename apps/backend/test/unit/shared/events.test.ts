import { describe, expect, it } from "vitest";
import {
  // Event name constants
  BACKEND_PORT_CHANGED,
  WORKSPACE_PROGRESS,
  FS_CHANGED,
  PTY_DATA,
  PTY_EXIT,
  BROWSER_NEW_TAB_REQUESTED,
  GIT_CLONE_PROGRESS,
  GIT_INIT_PROGRESS,
  // Schema map
  AppEventSchemaMap,
  // Individual schemas for targeted tests
  WorkspaceProgressSchema,
  FileChangeSchema,
  PtyDataSchema,
  GitCloneProgressSchema,
} from "@shared/events";

describe("shared/events", () => {
  describe("AppEventSchemaMap completeness", () => {
    const ALL_EVENT_NAMES = [
      BACKEND_PORT_CHANGED,
      WORKSPACE_PROGRESS,
      FS_CHANGED,
      PTY_DATA,
      PTY_EXIT,
      BROWSER_NEW_TAB_REQUESTED,
      GIT_CLONE_PROGRESS,
      GIT_INIT_PROGRESS,
    ];

    it("has a Zod schema for every event name constant", () => {
      for (const name of ALL_EVENT_NAMES) {
        expect(AppEventSchemaMap).toHaveProperty(name);
        expect(AppEventSchemaMap[name as keyof typeof AppEventSchemaMap]).toBeDefined();
      }
    });

    it("schema map has exactly the expected number of entries", () => {
      expect(Object.keys(AppEventSchemaMap)).toHaveLength(ALL_EVENT_NAMES.length);
    });
  });

  describe("schema validation — valid payloads", () => {
    it("WorkspaceProgressSchema accepts valid payload", () => {
      const result = WorkspaceProgressSchema.safeParse({
        workspaceId: "ws-1",
        step: "dependencies",
        label: "Installing deps...",
      });
      expect(result.success).toBe(true);
    });

    it("FileChangeSchema accepts valid payload", () => {
      const result = FileChangeSchema.safeParse({
        workspace_path: "/repo/.deus/alpha",
        change_type: "change",
        affected_count: 3,
      });
      expect(result.success).toBe(true);
    });

    it("PtyDataSchema accepts valid payload", () => {
      const result = PtyDataSchema.safeParse({
        id: "pty-1",
        data: [72, 101, 108, 108, 111],
      });
      expect(result.success).toBe(true);
    });

    it("GitCloneProgressSchema accepts valid payload", () => {
      const result = GitCloneProgressSchema.safeParse({
        line: "Receiving objects:  42% (100/238), 50.00 KiB | 1.00 MiB/s",
      });
      expect(result.success).toBe(true);
    });
  });

  describe("schema validation — rejects invalid payloads", () => {
    it("WorkspaceProgressSchema rejects missing required field", () => {
      const result = WorkspaceProgressSchema.safeParse({
        workspaceId: "ws-1",
        // missing step and label
      });
      expect(result.success).toBe(false);
    });

    it("FileChangeSchema rejects invalid change_type enum", () => {
      const result = FileChangeSchema.safeParse({
        workspace_path: "/repo",
        change_type: "deleted",
        affected_count: 1,
      });
      expect(result.success).toBe(false);
    });

    it("GitCloneProgressSchema rejects missing line field", () => {
      const result = GitCloneProgressSchema.safeParse({
        status: "Starting",
      });
      expect(result.success).toBe(false);
    });
  });
});
