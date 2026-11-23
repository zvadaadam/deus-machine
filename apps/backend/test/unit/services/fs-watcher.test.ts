import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileChanges } from "@shared/api/files";
import { dropConnection, subscribe, unsubscribe } from "../../../src/services/streams";
import { destroyAllWatchers } from "../../../src/services/fs-watcher.service";
import { scanWorkspaceFiles } from "../../../src/services/files.service";
import "../../../src/api/files";

const { watch, load, clients } = vi.hoisted(() => ({
  watch: vi.fn(),
  load: vi.fn(),
  clients: new Map<string, { type: string; data?: unknown }[]>(),
}));
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  watch,
}));
vi.mock("../../../src/middleware/workspace-loader", () => ({ loadWorkspace: load }));
vi.mock("../../../src/services/ws.service", () => ({
  getConnection: (id: string) => ({
    ws: { send: (raw: string) => clients.get(id)?.push(JSON.parse(raw)) },
  }),
}));

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const asPlatform = (value: string) =>
  Object.defineProperty(process, "platform", { ...platform, value });
function open(client: string, workspaceId = "w") {
  const frames: { type: string; data?: unknown }[] = [];
  clients.set(client, frames);
  subscribe(client, "files", fileChanges, { workspaceId });
  expect(frames.map((frame) => frame.type)).toEqual(["q:event", "q:subscribed"]);
  frames.length = 0; // From here the caller observes only subsequent edits or errors.
  return frames;
}
const native = (n = 0) => watch.mock.results[n].value as EventEmitter & { close: () => void };
const changed = (name: string | null, n = 0) => watch.mock.calls[n][2]("rename", name);

beforeEach(() => {
  asPlatform("darwin");
  vi.useFakeTimers();
  watch.mockReset().mockImplementation(() => Object.assign(new EventEmitter(), { close: vi.fn() }));
  load.mockReset().mockImplementation((id: string) => ({
    workspace: { current_session_id: "chat", state: "ready" },
    workspacePath: "/repo/.deus/" + id,
  }));
});
afterEach(() => {
  for (const id of clients.keys()) dropConnection(id);
  clients.clear();
  destroyAllWatchers();
  vi.useRealTimers();
  Object.defineProperty(process, "platform", platform);
});

describe("the fileChanges subscription", () => {
  it("returns the current cached tree when the watch starts and when it publishes", async () => {
    const root = await mkdtemp(join(tmpdir(), "deus-watch-cache-"));
    const tree = async () => (await scanWorkspaceFiles(root)).files.map((file) => file.path);
    try {
      execFileSync("git", ["init", "-q", root]);
      expect(await tree()).toEqual([]);
      await writeFile(join(root, "before-watch.txt"), "");
      load.mockReturnValueOnce({ workspacePath: root, workspace: { current_session_id: "chat" } });
      const frames = open("ui");
      const atStart = await tree();
      await writeFile(join(root, "during-watch.txt"), "");
      changed("during-watch.txt");
      vi.advanceTimersByTime(500);
      expect(frames.map((frame) => frame.type)).toEqual(["q:event"]);
      expect({ atStart, afterEvent: await tree() }).toEqual({
        atStart: ["before-watch.txt"],
        afterEvent: ["before-watch.txt", "during-watch.txt"],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("publishes during three seconds of continuous writes and again when they settle", () => {
    const frames = open("ui");
    for (let i = 0; i < 30; i++) {
      changed("dev.db-wal");
      vi.advanceTimersByTime(100);
    }
    expect(frames.map((frame) => frame.type)).toEqual(["q:event"]);
    vi.advanceTimersByTime(500);
    expect(frames.map((frame) => frame.type)).toEqual(["q:event", "q:event"]);
  });

  it("keeps watching for the second window, reuses a brief disconnect and closes after the last leaves", () => {
    const a = open("a");
    const b = open("b");
    expect(watch).toHaveBeenCalledExactlyOnceWith(
      "/repo/.deus/w",
      { recursive: true },
      expect.any(Function)
    );
    unsubscribe("a", "files");
    changed("src/a");
    vi.advanceTimersByTime(500);
    expect(a.map((f) => f.type)).toEqual([]);
    expect(b.map((f) => f.type)).toEqual(["q:event"]);
    dropConnection("b");
    vi.advanceTimersByTime(2000);
    open("back");
    vi.advanceTimersByTime(3000);
    expect(watch).toHaveBeenCalledTimes(1);
    expect(native().close).not.toHaveBeenCalled();
    dropConnection("back");
    vi.advanceTimersByTime(3000);
    expect(native().close).toHaveBeenCalledOnce();
    const back = open("new connection");
    expect(watch).toHaveBeenCalledTimes(2);
    // A late callback from the retired handle cannot stop its replacement.
    native().emit("error", new Error("closed"));
    changed("src/b", 1);
    vi.advanceTimersByTime(500);
    expect(back.map((f) => f.type)).toEqual(["q:event"]);
  });

  it("ignores private and generated subtrees, but hears recipes, hidden leaves and nameless events", () => {
    const frames = open("a");
    for (const name of [
      ".git/index.lock",
      "src/.cache/a",
      "build/output",
      "foo/node_modules/pkg",
      "target/log",
      "dist/app",
      ".deus/other/src",
      "src/.deus/environment.json",
    ])
      changed(name);
    vi.advanceTimersByTime(500);
    expect(frames).toHaveLength(0);
    for (const name of [
      ".deus",
      ".deus/environment.json",
      ".gitignore",
      "src/.save-tmp",
      null,
      "",
    ]) {
      changed(name);
      vi.advanceTimersByTime(500);
    }
    expect(frames.map((f) => f.data)).toEqual(Array(6).fill(null));
    for (let i = 0; i < 20; i++) {
      changed(".DS_Store");
      vi.advanceTimersByTime(10);
    }
    vi.advanceTimersByTime(499);
    expect(frames).toHaveLength(7);
  });

  it.each(["dist", "literal\\node_modules\\source"])(
    "hears an edit to the regular file %s",
    (name) => {
      const frames = open("ui");
      changed(name);
      vi.advanceTimersByTime(500);
      expect(frames.map((frame) => frame.type)).toEqual(["q:event"]);
    }
  );

  it("resolves the workspace on the host and refuses a missing scope, cloud workspace or absent checkout", () => {
    expect(() => subscribe("ui", "files", fileChanges, { workspacePath: "/" })).toThrow(
      "fileChanges"
    );
    for (const [workspacePath, current_session_id] of [
      ["", "chat"],
      ["/repo/.deus/w", null],
    ]) {
      load.mockReturnValueOnce({ workspacePath, workspace: { current_session_id } });
      expect(() => open("ui")).toThrow("local checkout");
    }
    expect(watch).not.toHaveBeenCalled();
  });

  it.each(["linux", "win32"])("leaves %s polling", (platform) => {
    asPlatform(platform);
    expect(() => open("ui")).toThrow("File watching is unavailable");
    expect(watch).not.toHaveBeenCalled();
  });

  it("refuses a failed start before acknowledging, and the next attempt can start", () => {
    watch.mockImplementationOnce(() => {
      throw new Error("ENOSPC");
    });
    expect(() => open("ui")).toThrow("ENOSPC");
    expect(clients.get("ui")).toEqual([]);
    open("ui");
    expect(watch).toHaveBeenCalledTimes(2);
  });

  it("ends every follower of a broken watch and leaves the other workspace delivering", () => {
    const a = open("a"),
      b = open("b"),
      other = open("c", "other");
    changed("pending");
    native().emit("error", new Error("watch failed"));
    changed("src/c", 1);
    vi.advanceTimersByTime(500);
    for (const frames of [a, b]) expect(frames.map((f) => f.type)).toEqual(["q:error"]);
    expect(other.map((f) => f.type)).toEqual(["q:event"]);
    expect(native().close).toHaveBeenCalledOnce();
    expect(unsubscribe("a", "files")).toBe(false);
    open("retry");
    expect(watch).toHaveBeenCalledTimes(3);
  });

  it.skipIf(platform.value !== "darwin")("hears a real hidden-sibling atomic save", async () => {
    vi.useRealTimers();
    const real = await vi.importActual<typeof import("node:fs")>("node:fs");
    watch.mockImplementationOnce(real.watch);
    const root = await mkdtemp(join(tmpdir(), "deus-atomic-"));
    try {
      await writeFile(join(root, "visible"), "old");
      load.mockReturnValueOnce({
        workspacePath: root,
        workspace: { current_session_id: "chat", state: "ready" },
      });
      const frames = open("ui");
      await writeFile(join(root, ".save-tmp"), "new");
      await rename(join(root, ".save-tmp"), join(root, "visible"));
      await vi.waitFor(() => expect(frames.map((f) => f.type)).toContain("q:event"), {
        timeout: 3500,
      });
    } finally {
      destroyAllWatchers();
      await rm(root, { recursive: true, force: true });
    }
  });
});
