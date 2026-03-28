import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";

// ============================================================================
// Mocks
// ============================================================================

const { mockBroadcast, mockWatcherOn, mockWatcherClose } = vi.hoisted(() => ({
  mockBroadcast: vi.fn(),
  mockWatcherOn: vi.fn().mockReturnThis(), // chainable .on()
  mockWatcherClose: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/services/ws.service", () => ({
  broadcast: mockBroadcast,
}));

vi.mock("chokidar", () => ({
  default: {
    watch: vi.fn(() => ({
      on: mockWatcherOn,
      close: mockWatcherClose,
    })),
  },
}));

// ============================================================================
// Import after mocks
// ============================================================================

import chokidar from "chokidar";
import {
  watchWorkspace,
  unwatchWorkspace,
  destroyAllWatchers,
} from "../../../src/services/fs-watcher.service";

// ============================================================================
// Helpers
// ============================================================================

/** Extract the handler registered for a chokidar event (e.g. "change", "add") */
function getChokidarHandler(eventName: string): ((...args: unknown[]) => void) | undefined {
  const call = mockWatcherOn.mock.calls.find((c: unknown[]) => c[0] === eventName);
  return call?.[1] as ((...args: unknown[]) => void) | undefined;
}

// ============================================================================
// Tests
// ============================================================================

describe("fs-watcher.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Reset internal state between tests
    destroyAllWatchers();
    vi.clearAllMocks(); // clear the destroy calls
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --------------------------------------------------------------------------
  // watchWorkspace — chokidar setup
  // --------------------------------------------------------------------------

  describe("watchWorkspace", () => {
    it("creates a chokidar watcher with cwd to avoid dotfile regex matching absolute paths", async () => {
      // Workspaces live at {repo}/.deus/{slug} — the absolute path contains
      // ".deus" which the dotfile regex /(^|[/\\])\./ would match if tested
      // against absolute paths. Using cwd ensures relative path testing.
      const workspacePath = "/Users/dev/project/.deus/my-workspace";
      await watchWorkspace(workspacePath);

      expect(chokidar.watch).toHaveBeenCalledWith(
        ".",
        expect.objectContaining({
          cwd: workspacePath,
        })
      );
    });

    it("passes the dotfile regex and standard ignore globs", async () => {
      await watchWorkspace("/tmp/test-workspace");

      const options = (chokidar.watch as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(options.ignored).toEqual(
        expect.arrayContaining([
          expect.any(RegExp),
          "**/node_modules/**",
          "**/target/**",
          "**/dist/**",
          "**/build/**",
        ])
      );
    });

    it("does not create duplicate watchers for the same path", async () => {
      await watchWorkspace("/tmp/workspace-a");
      await watchWorkspace("/tmp/workspace-a");

      expect(chokidar.watch).toHaveBeenCalledTimes(1);
    });

    it("registers handlers for add, change, unlink, addDir, unlinkDir, error", async () => {
      await watchWorkspace("/tmp/workspace");

      const registeredEvents = mockWatcherOn.mock.calls.map((c: unknown[]) => c[0]);
      expect(registeredEvents).toContain("add");
      expect(registeredEvents).toContain("change");
      expect(registeredEvents).toContain("unlink");
      expect(registeredEvents).toContain("addDir");
      expect(registeredEvents).toContain("unlinkDir");
      expect(registeredEvents).toContain("error");
    });
  });

  // --------------------------------------------------------------------------
  // Dotfile regex — the core bug fix
  // --------------------------------------------------------------------------

  describe("dotfile regex vs workspace paths", () => {
    it("the dotfile regex does NOT match normal relative file paths", async () => {
      await watchWorkspace("/tmp/workspace");

      const options = (chokidar.watch as ReturnType<typeof vi.fn>).mock.calls[0][1];
      const dotfileRegex = options.ignored.find((p: unknown) => p instanceof RegExp) as RegExp;

      // Normal source files should NOT be ignored
      expect(dotfileRegex.test("apps/web/src/App.tsx")).toBe(false);
      expect(dotfileRegex.test("src/index.ts")).toBe(false);
      expect(dotfileRegex.test("package.json")).toBe(false);
      expect(dotfileRegex.test("README.md")).toBe(false);
    });

    it("the dotfile regex matches dotfiles and dotdirs in relative paths", async () => {
      await watchWorkspace("/tmp/workspace");

      const options = (chokidar.watch as ReturnType<typeof vi.fn>).mock.calls[0][1];
      const dotfileRegex = options.ignored.find((p: unknown) => p instanceof RegExp) as RegExp;

      // Dotfiles/dirs should be ignored
      expect(dotfileRegex.test(".git")).toBe(true);
      expect(dotfileRegex.test(".env")).toBe(true);
      expect(dotfileRegex.test(".context/reviews")).toBe(true);
      expect(dotfileRegex.test("src/.hidden")).toBe(true);
    });

    it("the dotfile regex WOULD match .deus in absolute paths (the bug this fix prevents)", () => {
      const dotfileRegex = /(^|[/\\])\../;

      // This is why cwd is needed — absolute paths contain .deus
      expect(dotfileRegex.test("/Users/dev/project/.deus/workspace/src/App.tsx")).toBe(true);
      expect(dotfileRegex.test("/Users/dev/project/.conductor/ws/src/App.tsx")).toBe(true);

      // But relative paths from inside the workspace are fine
      expect(dotfileRegex.test("src/App.tsx")).toBe(false);
      expect(dotfileRegex.test("apps/web/src/App.tsx")).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Event debouncing + broadcast
  // --------------------------------------------------------------------------

  describe("file change events", () => {
    it("debounces rapid changes into a single broadcast", async () => {
      const workspacePath = "/tmp/workspace";
      await watchWorkspace(workspacePath);

      const onFileChange = getChokidarHandler("change")!;

      // Simulate 5 rapid file changes
      onFileChange("src/a.ts");
      onFileChange("src/b.ts");
      onFileChange("src/c.ts");
      onFileChange("src/d.ts");
      onFileChange("src/e.ts");

      // Not broadcast yet — debounce timer hasn't fired
      expect(mockBroadcast).not.toHaveBeenCalled();

      // Advance past the 500ms debounce
      vi.advanceTimersByTime(500);

      expect(mockBroadcast).toHaveBeenCalledOnce();
      const frame = JSON.parse(mockBroadcast.mock.calls[0][0]);
      expect(frame).toEqual({
        type: "q:event",
        event: "fs:changed",
        data: {
          workspace_path: workspacePath,
          change_type: "change",
          affected_count: 5,
        },
      });
    });

    it("reports mixed change_type when different event types fire together", async () => {
      const workspacePath = "/tmp/workspace";
      await watchWorkspace(workspacePath);

      const onAdd = getChokidarHandler("add")!;
      const onChange = getChokidarHandler("change")!;
      const onUnlink = getChokidarHandler("unlink")!;

      onAdd("src/new.ts");
      onChange("src/existing.ts");
      onUnlink("src/deleted.ts");

      vi.advanceTimersByTime(500);

      const frame = JSON.parse(mockBroadcast.mock.calls[0][0]);
      expect(frame.data.change_type).toBe("mixed");
      expect(frame.data.affected_count).toBe(3);
    });

    it("resets count after flushing", async () => {
      await watchWorkspace("/tmp/workspace");

      const onChange = getChokidarHandler("change")!;

      // First batch
      onChange("a.ts");
      onChange("b.ts");
      vi.advanceTimersByTime(500);

      expect(mockBroadcast).toHaveBeenCalledTimes(1);
      expect(JSON.parse(mockBroadcast.mock.calls[0][0]).data.affected_count).toBe(2);

      // Second batch
      onChange("c.ts");
      vi.advanceTimersByTime(500);

      expect(mockBroadcast).toHaveBeenCalledTimes(2);
      expect(JSON.parse(mockBroadcast.mock.calls[1][0]).data.affected_count).toBe(1);
    });

    it("does not broadcast if no changes occurred", async () => {
      await watchWorkspace("/tmp/workspace");

      // Just advance time without any file changes
      vi.advanceTimersByTime(5000);

      expect(mockBroadcast).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // unwatchWorkspace
  // --------------------------------------------------------------------------

  describe("unwatchWorkspace", () => {
    it("closes the watcher and allows re-watching the same path", async () => {
      await watchWorkspace("/tmp/workspace");
      expect(chokidar.watch).toHaveBeenCalledTimes(1);

      await unwatchWorkspace("/tmp/workspace");
      expect(mockWatcherClose).toHaveBeenCalledOnce();

      // Can re-watch after unwatch
      await watchWorkspace("/tmp/workspace");
      expect(chokidar.watch).toHaveBeenCalledTimes(2);
    });

    it("clears pending debounce timers on unwatch", async () => {
      await watchWorkspace("/tmp/workspace");

      const onChange = getChokidarHandler("change")!;
      onChange("a.ts"); // Start debounce timer

      await unwatchWorkspace("/tmp/workspace");

      // Advance past debounce — should NOT broadcast since we unwatched
      vi.advanceTimersByTime(500);
      expect(mockBroadcast).not.toHaveBeenCalled();
    });

    it("no-ops for paths that are not being watched", async () => {
      // Should not throw
      await unwatchWorkspace("/tmp/not-watched");
      expect(mockWatcherClose).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // destroyAllWatchers
  // --------------------------------------------------------------------------

  describe("destroyAllWatchers", () => {
    it("closes all active watchers", async () => {
      await watchWorkspace("/tmp/workspace-1");
      await watchWorkspace("/tmp/workspace-2");

      destroyAllWatchers();

      // Each watcher's close() should have been called
      expect(mockWatcherClose).toHaveBeenCalledTimes(2);
    });
  });
});
