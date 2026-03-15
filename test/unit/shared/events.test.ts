import { describe, expect, it } from "vitest";
import {
  // Event name constants
  WORKSPACE_PROGRESS,
  SIDECAR_REQUEST,
  FS_CHANGED,
  PTY_DATA,
  PTY_EXIT,
  BROWSER_PAGE_LOAD,
  BROWSER_TITLE_CHANGED,
  BROWSER_URL_CHANGE,
  BROWSER_WORKSPACE_CHANGE,
  SIM_BUILD_LOG,
  CHAT_INSERT,
  GIT_CLONE_PROGRESS,
  // Schema map
  AppEventSchemaMap,
  // Individual schemas for targeted tests
  WorkspaceProgressSchema,
  FileChangeSchema,
  PtyDataSchema,
  ChatInsertSchema,
  GitCloneProgressSchema,
  BrowserWorkspaceChangeSchema,
  // Domain constants
  QUERY_RESOURCES,
  MUTATION_NAMES,
  COMMAND_NAMES,
  PROTOCOL_EVENTS,
  SIDECAR_NOTIFY_EVENTS,
} from "@shared/events";

describe("shared/events", () => {
  describe("AppEventSchemaMap completeness", () => {
    const ALL_EVENT_NAMES = [
      WORKSPACE_PROGRESS,
      SIDECAR_REQUEST,
      FS_CHANGED,
      PTY_DATA,
      PTY_EXIT,
      BROWSER_PAGE_LOAD,
      BROWSER_TITLE_CHANGED,
      BROWSER_URL_CHANGE,
      BROWSER_WORKSPACE_CHANGE,
      SIM_BUILD_LOG,
      CHAT_INSERT,
      GIT_CLONE_PROGRESS,
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
        workspace_path: "/repo/.opendevs/alpha",
        change_type: "fileschanged",
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

    it("ChatInsertSchema accepts text variant", () => {
      const result = ChatInsertSchema.safeParse({
        type: "text",
        workspaceId: "ws-1",
        text: "Hello from chat",
      });
      expect(result.success).toBe(true);
    });

    it("ChatInsertSchema accepts element variant with InspectElement fields", () => {
      const result = ChatInsertSchema.safeParse({
        type: "element",
        workspaceId: "ws-1",
        element: {
          ref: "ref-1",
          tagName: "button",
          path: "body > div > button",
          innerText: "Click me",
          context: "local",
        },
      });
      expect(result.success).toBe(true);
    });

    it("ChatInsertSchema accepts files variant", () => {
      const result = ChatInsertSchema.safeParse({
        type: "files",
        workspaceId: "ws-1",
        files: [{ name: "shot.png", type: "image/png", lastModified: 123, base64: "abc==" }],
      });
      expect(result.success).toBe(true);
    });

    it("GitCloneProgressSchema accepts valid payload", () => {
      const result = GitCloneProgressSchema.safeParse({
        percent: 42,
        received: 100,
        total: 238,
        received_bytes: 51200,
        status: "Receiving objects",
        phase: "receiving",
      });
      expect(result.success).toBe(true);
    });

    it("BrowserWorkspaceChangeSchema accepts nullish fields", () => {
      const result = BrowserWorkspaceChangeSchema.safeParse({
        workspaceId: "ws-1",
        directoryName: null,
        repoName: undefined,
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

    it("ChatInsertSchema rejects element with missing required fields", () => {
      const result = ChatInsertSchema.safeParse({
        type: "element",
        workspaceId: "ws-1",
        element: { tagName: "div" }, // missing ref and path
      });
      expect(result.success).toBe(false);
    });

    it("GitCloneProgressSchema rejects invalid phase enum", () => {
      const result = GitCloneProgressSchema.safeParse({
        percent: 0,
        received: 0,
        total: 0,
        received_bytes: 0,
        status: "Starting",
        phase: "downloading", // not a valid phase
      });
      expect(result.success).toBe(false);
    });
  });

  describe("domain constant arrays", () => {
    it("QUERY_RESOURCES contains the expected resources", () => {
      expect(QUERY_RESOURCES).toContain("workspaces");
      expect(QUERY_RESOURCES).toContain("stats");
      expect(QUERY_RESOURCES).toContain("sessions");
      expect(QUERY_RESOURCES).toContain("session");
      expect(QUERY_RESOURCES).toContain("messages");
      expect(QUERY_RESOURCES).toHaveLength(5);
    });

    it("MUTATION_NAMES contains the expected mutations", () => {
      expect(MUTATION_NAMES).toContain("archiveWorkspace");
      expect(MUTATION_NAMES).toContain("updateWorkspaceTitle");
      expect(MUTATION_NAMES).toHaveLength(2);
    });

    it("COMMAND_NAMES contains the expected commands", () => {
      expect(COMMAND_NAMES).toContain("sendMessage");
      expect(COMMAND_NAMES).toContain("stopSession");
      expect(COMMAND_NAMES).toHaveLength(2);
    });

    it("PROTOCOL_EVENTS contains the expected events", () => {
      expect(PROTOCOL_EVENTS).toContain("session:plan-mode");
      expect(PROTOCOL_EVENTS).toContain("session:error");
      expect(PROTOCOL_EVENTS).toContain("session:progress");
      expect(PROTOCOL_EVENTS).toHaveLength(3);
    });

    it("SIDECAR_NOTIFY_EVENTS contains the expected events", () => {
      expect(SIDECAR_NOTIFY_EVENTS).toContain("session:message");
      expect(SIDECAR_NOTIFY_EVENTS).toContain("session:status");
      expect(SIDECAR_NOTIFY_EVENTS).toContain("session:updated");
      expect(SIDECAR_NOTIFY_EVENTS).toHaveLength(3);
    });
  });
});
