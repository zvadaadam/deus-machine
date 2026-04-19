import { describe, expect, it } from "vitest";
import {
  // Event name constants
  BACKEND_PORT_CHANGED,
  WORKSPACE_PROGRESS,
  FS_CHANGED,
  PTY_DATA,
  PTY_EXIT,
  BROWSER_PAGE_LOAD,
  BROWSER_TITLE_CHANGED,
  BROWSER_URL_CHANGE,
  BROWSER_WORKSPACE_CHANGE,
  BROWSER_DETACHED_CLOSED,
  BROWSER_NEW_TAB_REQUESTED,
  CHAT_INSERT,
  GIT_CLONE_PROGRESS,
  GIT_INIT_PROGRESS,
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
  REQUEST_RESOURCES,
  MUTATION_NAMES,
  COMMAND_NAMES,
  PROTOCOL_EVENTS,
} from "@shared/events";

describe("shared/events", () => {
  describe("AppEventSchemaMap completeness", () => {
    const ALL_EVENT_NAMES = [
      BACKEND_PORT_CHANGED,
      WORKSPACE_PROGRESS,
      FS_CHANGED,
      PTY_DATA,
      PTY_EXIT,
      BROWSER_PAGE_LOAD,
      BROWSER_TITLE_CHANGED,
      BROWSER_URL_CHANGE,
      BROWSER_WORKSPACE_CHANGE,
      BROWSER_DETACHED_CLOSED,
      BROWSER_NEW_TAB_REQUESTED,
      CHAT_INSERT,
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
        line: "Receiving objects:  42% (100/238), 50.00 KiB | 1.00 MiB/s",
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

    it("GitCloneProgressSchema rejects missing line field", () => {
      const result = GitCloneProgressSchema.safeParse({
        status: "Starting",
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
      // AAP resources
      expect(QUERY_RESOURCES).toContain("apps");
      expect(QUERY_RESOURCES).toContain("running_apps");
      expect(QUERY_RESOURCES).toHaveLength(7);
    });

    it("MUTATION_NAMES contains the expected mutations", () => {
      expect(MUTATION_NAMES).toContain("archiveWorkspace");
      expect(MUTATION_NAMES).toContain("updateWorkspaceTitle");
      expect(MUTATION_NAMES).toContain("updateWorkspaceStatus");
      // New mutations
      expect(MUTATION_NAMES).toContain("updateWorkspace");
      expect(MUTATION_NAMES).toContain("createSession");
      expect(MUTATION_NAMES).toContain("addRepo");
      expect(MUTATION_NAMES).toContain("saveRepoManifest");
      expect(MUTATION_NAMES).toContain("saveAgentConfig");
      expect(MUTATION_NAMES).toContain("deleteAgentConfig");
      expect(MUTATION_NAMES).toContain("saveSetting");
      expect(MUTATION_NAMES).toContain("invalidateFileCache");
      expect(MUTATION_NAMES).toContain("revokeDevice");
      expect(MUTATION_NAMES).toContain("runTask");
      expect(MUTATION_NAMES).toHaveLength(13);
    });

    it("COMMAND_NAMES contains the expected commands", () => {
      expect(COMMAND_NAMES).toContain("sendMessage");
      expect(COMMAND_NAMES).toContain("stopSession");
      expect(COMMAND_NAMES).toContain("pty:spawn");
      expect(COMMAND_NAMES).toContain("pty:write");
      expect(COMMAND_NAMES).toContain("pty:resize");
      expect(COMMAND_NAMES).toContain("pty:kill");
      expect(COMMAND_NAMES).toContain("fs:watch");
      expect(COMMAND_NAMES).toContain("fs:unwatch");
      expect(COMMAND_NAMES).toContain("git:clone");
      expect(COMMAND_NAMES).toContain("git:init");
      // New commands
      expect(COMMAND_NAMES).toContain("createWorkspace");
      expect(COMMAND_NAMES).toContain("retrySetup");
      expect(COMMAND_NAMES).toContain("openPenFile");
      // Simulator commands
      expect(COMMAND_NAMES).toContain("sim:listDevices");
      expect(COMMAND_NAMES).toContain("sim:start");
      expect(COMMAND_NAMES).toContain("sim:stop");
      expect(COMMAND_NAMES).toContain("sim:touch");
      expect(COMMAND_NAMES).toContain("sim:screenshot");
      expect(COMMAND_NAMES).toContain("sim:buildAndRun");
      // AAP commands
      expect(COMMAND_NAMES).toContain("launchApp");
      expect(COMMAND_NAMES).toContain("stopApp");
      expect(COMMAND_NAMES).toHaveLength(28);
    });

    it("REQUEST_RESOURCES contains the expected request-only resources", () => {
      expect(REQUEST_RESOURCES).toContain("settings");
      expect(REQUEST_RESOURCES).toContain("repos");
      expect(REQUEST_RESOURCES).toContain("repoManifest");
      expect(REQUEST_RESOURCES).toContain("detectManifest");
      expect(REQUEST_RESOURCES).toContain("agentConfig");
      expect(REQUEST_RESOURCES).toContain("ghStatus");
      expect(REQUEST_RESOURCES).toContain("prStatus");
      expect(REQUEST_RESOURCES).toContain("workspace");
      expect(REQUEST_RESOURCES).toContain("allWorkspaces");
      expect(REQUEST_RESOURCES).toContain("workspaceManifest");
      expect(REQUEST_RESOURCES).toContain("setupLogs");
      expect(REQUEST_RESOURCES).toContain("diffStats");
      expect(REQUEST_RESOURCES).toContain("diffFiles");
      expect(REQUEST_RESOURCES).toContain("diffFile");
      expect(REQUEST_RESOURCES).toContain("penFiles");
      expect(REQUEST_RESOURCES).toContain("workspaceFiles");
      expect(REQUEST_RESOURCES).toContain("fileContent");
      expect(REQUEST_RESOURCES).toContain("fileSearch");
      expect(REQUEST_RESOURCES).toContain("recentProjects");
      expect(REQUEST_RESOURCES).toContain("pairedDevices");
      expect(REQUEST_RESOURCES).toContain("relayStatus");
      expect(REQUEST_RESOURCES).toContain("allSessions");
      expect(REQUEST_RESOURCES).toContain("repoPrs");
      expect(REQUEST_RESOURCES).toContain("repoBranches");
      expect(REQUEST_RESOURCES).toContain("agentAuth");
      expect(REQUEST_RESOURCES).toHaveLength(25);
    });

    it("PROTOCOL_EVENTS contains the expected events", () => {
      expect(PROTOCOL_EVENTS).toContain("session:plan-mode");
      expect(PROTOCOL_EVENTS).toContain("session:error");
      expect(PROTOCOL_EVENTS).toContain("session:progress");
      expect(PROTOCOL_EVENTS).toContain("tool:request");
      // Message lifecycle events
      expect(PROTOCOL_EVENTS).toContain("message:created");
      expect(PROTOCOL_EVENTS).toContain("message:done");
      // Part lifecycle events
      expect(PROTOCOL_EVENTS).toContain("part:created");
      expect(PROTOCOL_EVENTS).toContain("part:delta");
      expect(PROTOCOL_EVENTS).toContain("part:done");
      expect(PROTOCOL_EVENTS).toContain("pty-data");
      expect(PROTOCOL_EVENTS).toContain("pty-exit");
      expect(PROTOCOL_EVENTS).toContain("fs:changed");
      expect(PROTOCOL_EVENTS).toContain("git-clone-progress");
      expect(PROTOCOL_EVENTS).toContain("git-init-progress");
      expect(PROTOCOL_EVENTS).toContain("agent-server:request");
      // Simulator events
      expect(PROTOCOL_EVENTS).toContain("sim:streamReady");
      expect(PROTOCOL_EVENTS).toContain("sim:stopped");
      expect(PROTOCOL_EVENTS).toContain("sim:buildLog");
      expect(PROTOCOL_EVENTS).toContain("sim:buildComplete");
      expect(PROTOCOL_EVENTS).toContain("sim:buildFailed");
      expect(PROTOCOL_EVENTS).toContain("sim:streamFailed");
      // AAP events
      expect(PROTOCOL_EVENTS).toContain("apps:launched");
      expect(PROTOCOL_EVENTS).toContain("apps:stopped");
      expect(PROTOCOL_EVENTS).toHaveLength(23);
    });
  });
});
