import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { fileChanges } from "@shared/api/files";
import { destroyAllWatchers, watchWorkspace } from "../../../src/services/fs-watcher.service";
import { dropConnection, onFollow, subscribe, unsubscribe } from "../../../src/services/streams";
import { addConnection, removeConnection } from "../../../src/services/ws.service";

// Only the workspace lookup is replaced: use a disposable folder, the real
// follower lifecycle, its native watch, and what actually goes over the wire.
it("delivers checkout changes with a bounded descriptor cost", async () => {
  const root = mkdtempSync(join(tmpdir(), "deus-watch-"));
  let onEvent = () => {};
  const connection = addConnection(
    {
      send: (raw) => {
        if (JSON.parse(String(raw)).type === "q:event") onEvent();
      },
      close: () => {},
    },
    null
  );
  onFollow(fileChanges, ({ workspaceId }) => watchWorkspace(workspaceId, root));
  const start = () => subscribe(connection, "files", fileChanges, { workspaceId: "w" });
  const end = () => {
    // Expire the grace period on every release, including all 100 cycles below.
    vi.useFakeTimers();
    try {
      expect(unsubscribe(connection, "files")).toBe(true);
      vi.advanceTimersByTime(4000);
    } finally {
      vi.useRealTimers();
    }
  };
  const count = () => readdirSync("/dev/fd").length;
  try {
    if (process.platform !== "darwin") {
      expect(start).toThrow("File watching is unavailable");
      return;
    }
    const initial = count();
    const held: number[] = [];
    for (const size of [50, 500]) {
      for (let i = 0; i < size; i++) writeFileSync(join(root, "file-" + i), "first");
      start();
      await wait(50);
      held.push(count());
      end();
    }
    expect(held[0]).toBeLessThanOrEqual(initial + 4);
    expect(held[1]).toBeLessThanOrEqual(held[0] + 4);

    start();
    const visible = join(root, "visible");
    for (const edit of [
      () => writeFileSync(visible, "create"),
      () => writeFileSync(visible, "modify"),
      () => {
        const tmp = join(root, ".save-tmp");
        writeFileSync(tmp, "new");
        renameSync(tmp, visible);
      },
      () => unlinkSync(visible),
    ]) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("No fileChanges event after " + edit.name)),
          3000
        );
        onEvent = () => {
          clearTimeout(timer);
          resolve();
        };
        edit();
      });
    }
    end();

    const baseline = count();
    for (let i = 0; i < 100; i++) {
      start();
      await wait(10);
      end();
      await wait(10);
    }
    // Bun 1.3.6 retains one FD per closed macOS recursive watch. Tighten to
    // zero with the runtime upgrade. Node returns to its warmed baseline.
    expect(count() - baseline).toBeLessThanOrEqual(process.versions.bun ? 100 : 0);
    expect(execFileSync("/bin/echo", ["watcher-parity"], { encoding: "utf8", timeout: 2000 })).toBe(
      "watcher-parity\n"
    );
  } finally {
    dropConnection(connection);
    removeConnection(connection);
    destroyAllWatchers();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
