import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Router } from "../router";
import type { BackendClient } from "../clients/backend";
import type { SidecarClient } from "../clients/sidecar";
import type { BindingStore } from "../lib/binding-store";
import type { ChannelAdapter } from "../adapters/types";
import type { InboundMessage, ChannelBinding } from "../types";
import { EventEmitter } from "events";

function createMockBackend(): BackendClient {
  return {
    listRepos: vi.fn().mockResolvedValue([]),
    listWorkspacesByRepo: vi.fn().mockResolvedValue([]),
    getWorkspace: vi.fn().mockResolvedValue({}),
    listSessions: vi.fn().mockResolvedValue([]),
    getSession: vi.fn().mockResolvedValue({ id: "sess-1", status: "idle" }),
    sendMessage: vi.fn().mockResolvedValue({ id: "msg-1" }),
    stopSession: vi.fn().mockResolvedValue({ success: true, message: "Stopped" }),
    getDiffStats: vi.fn().mockResolvedValue({ additions: 10, deletions: 5, files_changed: 3 }),
    createSession: vi.fn().mockResolvedValue({ id: "sess-new", status: "idle", agent_type: "claude" }),
  } as unknown as BackendClient;
}

function createMockSidecar(): SidecarClient & EventEmitter {
  const emitter = new EventEmitter() as SidecarClient & EventEmitter;
  (emitter as any).sendQuery = vi.fn();
  (emitter as any).sendCancel = vi.fn();
  (emitter as any).connected = true;
  return emitter;
}

function createMockAdapter(): ChannelAdapter {
  return {
    channel: "telegram",
    start: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockBindings(): BindingStore {
  const store = new Map<string, ChannelBinding>();
  return {
    get: vi.fn((channel: string, chatId: string) => store.get(`${channel}:${chatId}`)),
    set: vi.fn((binding: ChannelBinding) => {
      store.set(`${binding.channel}:${binding.chatId}`, binding);
    }),
    remove: vi.fn((channel: string, chatId: string) => store.delete(`${channel}:${chatId}`)),
    all: vi.fn(() => [...store.values()]),
    byWorkspace: vi.fn((wsId: string) => [...store.values()].filter((b) => b.workspaceId === wsId)),
  } as unknown as BindingStore;
}

function makeInbound(overrides?: Partial<InboundMessage>): InboundMessage {
  return {
    channel: "telegram",
    chatId: "12345",
    userId: "user-1",
    text: "hello",
    messageId: "msg-1",
    ...overrides,
  };
}

function makeBinding(overrides?: Partial<ChannelBinding>): ChannelBinding {
  return {
    channel: "telegram",
    chatId: "12345",
    workspaceId: "ws-abc",
    sessionId: "sess-xyz",
    workspacePath: "/tmp/workspace",
    repoName: "my-app",
    workspaceName: "happy-cat",
    ...overrides,
  };
}

describe("Router", () => {
  let backend: ReturnType<typeof createMockBackend>;
  let sidecar: ReturnType<typeof createMockSidecar>;
  let bindings: ReturnType<typeof createMockBindings>;
  let adapter: ReturnType<typeof createMockAdapter>;
  let router: Router;

  beforeEach(() => {
    backend = createMockBackend();
    sidecar = createMockSidecar();
    bindings = createMockBindings();
    adapter = createMockAdapter();
    router = new Router(backend as any, sidecar as any, bindings as any);
    router.registerAdapter(adapter);
  });

  // ---- Command handling ----

  describe("commands", () => {
    it("responds to /help", async () => {
      await router.handleInbound(makeInbound({ text: "/help" }));
      expect(adapter.send).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("Commands") })
      );
    });

    it("responds to /repos with workspace list", async () => {
      (backend.listWorkspacesByRepo as any).mockResolvedValue([
        {
          repo_name: "my-app",
          workspaces: [{ id: "w1", name: "happy-cat", state: "active" }],
        },
      ]);

      await router.handleInbound(makeInbound({ text: "/repos" }));
      expect(adapter.send).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("my-app") })
      );
    });

    it("binds a workspace with /workspace <name>", async () => {
      (backend.listWorkspacesByRepo as any).mockResolvedValue([
        {
          repo_name: "my-app",
          workspaces: [{ id: "w1", name: "happy-cat", state: "active", workspace_path: "/tmp/ws" }],
        },
      ]);
      (backend.listSessions as any).mockResolvedValue([
        { id: "sess-1", status: "idle", agent_type: "claude" },
      ]);

      await router.handleInbound(makeInbound({ text: "/workspace happy-cat" }));
      expect(bindings.set).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: "w1",
          sessionId: "sess-1",
          workspaceName: "happy-cat",
        })
      );
    });

    it("creates a new session if none exists", async () => {
      (backend.listWorkspacesByRepo as any).mockResolvedValue([
        {
          repo_name: "my-app",
          workspaces: [{ id: "w1", name: "happy-cat", state: "active", workspace_path: "/tmp/ws" }],
        },
      ]);
      (backend.listSessions as any).mockResolvedValue([]);

      await router.handleInbound(makeInbound({ text: "/workspace happy-cat" }));
      expect(backend.createSession).toHaveBeenCalledWith("w1");
    });

    it("replies with error when workspace not found", async () => {
      (backend.listWorkspacesByRepo as any).mockResolvedValue([]);

      await router.handleInbound(makeInbound({ text: "/workspace nonexistent" }));
      expect(adapter.send).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("No workspace found") })
      );
    });

    it("responds to /status with session info", async () => {
      bindings.set(makeBinding());
      (backend.getSession as any).mockResolvedValue({
        id: "sess-xyz",
        status: "working",
        title: "Fix login",
      });

      await router.handleInbound(makeInbound({ text: "/status" }));
      expect(adapter.send).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("working") })
      );
    });

    it("requires binding for /status", async () => {
      await router.handleInbound(makeInbound({ text: "/status" }));
      expect(adapter.send).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("No workspace bound") })
      );
    });

    it("responds to /diff with stats", async () => {
      bindings.set(makeBinding());

      await router.handleInbound(makeInbound({ text: "/diff" }));
      expect(adapter.send).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("Files changed") })
      );
    });

    it("responds to /stop", async () => {
      bindings.set(makeBinding());

      await router.handleInbound(makeInbound({ text: "/stop" }));
      expect(backend.stopSession).toHaveBeenCalledWith("sess-xyz");
      expect((sidecar as any).sendCancel).toHaveBeenCalledWith("sess-xyz");
    });

    it("responds to /unbind", async () => {
      bindings.set(makeBinding());

      await router.handleInbound(makeInbound({ text: "/unbind" }));
      expect(bindings.remove).toHaveBeenCalledWith("telegram", "12345");
    });
  });

  // ---- Agent query dispatch ----

  describe("agent queries", () => {
    it("dispatches regular messages to backend + sidecar", async () => {
      bindings.set(makeBinding());

      await router.handleInbound(makeInbound({ text: "fix the login bug" }));

      expect(backend.sendMessage).toHaveBeenCalledWith("sess-xyz", "fix the login bug");
      expect((sidecar as any).sendQuery).toHaveBeenCalledWith(
        "sess-xyz",
        "fix the login bug",
        { cwd: "/tmp/workspace" }
      );
    });

    it("requires binding for regular messages", async () => {
      await router.handleInbound(makeInbound({ text: "fix the login bug" }));
      expect(adapter.send).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("No workspace bound") })
      );
      expect(backend.sendMessage).not.toHaveBeenCalled();
    });

    it("reports backend errors to user", async () => {
      bindings.set(makeBinding());
      (backend.sendMessage as any).mockRejectedValue(new Error("DB error"));

      await router.handleInbound(makeInbound({ text: "hello" }));
      expect(adapter.send).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("Failed to send") })
      );
    });
  });

  // ---- Agent response handling ----

  describe("agent responses", () => {
    it("routes agent messages to the correct chat", async () => {
      bindings.set(makeBinding());
      router.startListening();

      // Simulate agent message
      sidecar.emit("message", {
        id: "sess-xyz",
        type: "message",
        agentType: "claude",
        data: {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "I found the bug!" }],
          },
        },
      });

      // Wait for batch flush (2s delay)
      await vi.waitFor(
        () => {
          expect(adapter.send).toHaveBeenCalled();
        },
        { timeout: 5000, interval: 100 }
      );

      expect(adapter.send).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: "12345",
          text: expect.stringContaining("I found the bug!"),
        })
      );
    });

    it("routes agent errors to the correct chat", async () => {
      bindings.set(makeBinding());
      router.startListening();

      sidecar.emit("error", {
        id: "sess-xyz",
        type: "error",
        error: "Something went wrong",
        agentType: "claude",
      });

      // Error messages are sent immediately (no batching)
      await vi.waitFor(() => {
        expect(adapter.send).toHaveBeenCalled();
      });

      expect(adapter.send).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Something went wrong"),
        })
      );
    });

    it("ignores messages for unknown sessions", () => {
      router.startListening();

      // No binding exists for this session
      sidecar.emit("message", {
        id: "unknown-sess",
        type: "message",
        agentType: "claude",
        data: { type: "text", text: "hello" },
      });

      expect(adapter.send).not.toHaveBeenCalled();
    });
  });
});
