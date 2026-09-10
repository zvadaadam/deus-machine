import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

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
    it("uses the workspace cwd for relative change events", async () => {
      const workspacePath = "/Users/dev/project/.deus/my-workspace";
      await watchWorkspace(workspacePath);

      expect(chokidar.watch).toHaveBeenCalledWith(
        ".",
        expect.objectContaining({
          cwd: workspacePath,
        })
      );
    });

    it("ignores generated directories at any depth", async () => {
      await watchWorkspace("/tmp/test-workspace");
      const ignores = (chokidar.watch as ReturnType<typeof vi.fn>).mock.calls[0][1].ignored[0];
      for (const name of ["node_modules", "target", "dist", "build"]) {
        expect(ignores(`/tmp/test-workspace/${name}`)).toBe(true);
        expect(ignores(`apps/web/${name}/output.js`)).toBe(true);
      }
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
      const ignores = options.ignored.find((p: unknown) => typeof p === "function") as (
        path: string
      ) => boolean;

      // Normal source files should NOT be ignored
      expect(ignores("apps/web/src/App.tsx")).toBe(false);
      expect(ignores("src/index.ts")).toBe(false);
      expect(ignores("package.json")).toBe(false);
      expect(ignores("README.md")).toBe(false);
    });

    it("the dotfile regex matches dotfiles and dotdirs in relative paths", async () => {
      await watchWorkspace("/tmp/workspace");

      const options = (chokidar.watch as ReturnType<typeof vi.fn>).mock.calls[0][1];
      const ignores = options.ignored.find((p: unknown) => typeof p === "function") as (
        path: string
      ) => boolean;

      // Dotfiles/dirs should be ignored
      expect(ignores(".git")).toBe(true);
      expect(ignores(".env")).toBe(true);
      expect(ignores(".context/reviews")).toBe(true);
      expect(ignores("src/.hidden")).toBe(true);
    });

    it("watches the environment file without descending into sibling worktrees", async () => {
      await watchWorkspace("/tmp/workspace");
      const ignores = (chokidar.watch as ReturnType<typeof vi.fn>).mock.calls[0][1].ignored[0];
      expect(ignores(".deus")).toBe(false);
      expect(ignores(".deus/environment.json")).toBe(false);
      expect(ignores(".deus/another-workspace")).toBe(true);
      expect(ignores("src/.deus/environment.json")).toBe(true);
    });

    it("normalizes absolute callback paths inside a .deus workspace", async () => {
      const workspacePath = "/tmp/project/.deus/workspace";
      await watchWorkspace(workspacePath);
      const ignores = (chokidar.watch as ReturnType<typeof vi.fn>).mock.calls[0][1].ignored[0];
      expect(ignores(workspacePath)).toBe(false);
      expect(ignores(`${workspacePath}/src/index.ts`)).toBe(false);
      expect(ignores(`${workspacePath}/.deus`)).toBe(false);
      expect(ignores(`${workspacePath}/.deus/environment.json`)).toBe(false);
      expect(ignores(`${workspacePath}/.env`)).toBe(true);
      expect(ignores(`${workspacePath}/.deus/other-workspace`)).toBe(true);
    });
  });

  it("broadcasts real recipe edits inside a .deus workspace while ignoring private and generated files", async () => {
    vi.useRealTimers();
    const realChokidar = await vi.importActual<typeof import("chokidar")>("chokidar");
    vi.mocked(chokidar.watch).mockImplementationOnce(realChokidar.watch);
    const fixtureRoot = path.resolve(import.meta.dirname, "../../../../../.context");
    await mkdir(fixtureRoot, { recursive: true });
    const fixture = await mkdtemp(path.join(fixtureRoot, "fs-watcher-test-"));
    const workspacePath = path.join(fixture, ".deus", "workspace");
    const recipePath = path.join(workspacePath, ".deus", "environment.json");
    const ignoredFiles = [
      ".env",
      ".git/config",
      ".deus/other-workspace/private.txt",
      "node_modules/package/index.js",
      "apps/web/node_modules/package/index.js",
      "dist/app.js",
      "target/artifact",
      "build/output.js",
    ].map((file) => path.join(workspacePath, file));
    try {
      for (const file of [recipePath, ...ignoredFiles]) {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, "initial\n");
      }
      await watchWorkspace(workspacePath);
      const watcher = vi.mocked(chokidar.watch).mock.results.at(-1)!.value as ReturnType<
        typeof realChokidar.watch
      >;
      await new Promise<void>((resolve, reject) => {
        watcher.once("ready", resolve);
        watcher.once("error", reject);
      });

      await Promise.all([recipePath, ...ignoredFiles].map((file) => writeFile(file, "changed\n")));
      await vi.waitFor(() => expect(mockBroadcast).toHaveBeenCalledOnce(), { timeout: 3000 });
      expect(JSON.parse(mockBroadcast.mock.calls[0][0])).toEqual({
        type: "q:event",
        event: "fs:changed",
        data: {
          workspace_path: workspacePath,
          change_type: "change",
          affected_count: 1,
        },
      });
    } finally {
      await unwatchWorkspace(workspacePath);
      await rm(fixture, { recursive: true, force: true });
    }
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
