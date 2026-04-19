import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, existsSync, rmSync } from "node:fs";

import { ensureStorageDirs, injectGitignore } from "../../../../src/services/aap/storage";

describe("aap/storage", () => {
  let workRoot: string;

  beforeEach(async () => {
    workRoot = await mkdtemp(join(tmpdir(), "aap-storage-test-"));
  });

  afterEach(() => {
    rmSync(workRoot, { recursive: true, force: true });
  });

  describe("ensureStorageDirs", () => {
    it("creates workspace and global dirs if they don't exist", async () => {
      const ws = join(workRoot, "ws-dir");
      const glob = join(workRoot, "global-dir");
      await ensureStorageDirs({ workspace: ws, global: glob });
      expect(existsSync(ws)).toBe(true);
      expect(existsSync(glob)).toBe(true);
    });

    it("is idempotent when dirs already exist", async () => {
      const ws = join(workRoot, "existing");
      mkdirSync(ws, { recursive: true });
      await ensureStorageDirs({ workspace: ws });
      expect(existsSync(ws)).toBe(true);
    });

    it("creates nested paths with -p behavior", async () => {
      const deep = join(workRoot, "a", "b", "c", "d");
      await ensureStorageDirs({ workspace: deep });
      expect(existsSync(deep)).toBe(true);
    });

    it("is a no-op when paths are undefined", async () => {
      await ensureStorageDirs({});
      // no assertions — just ensuring it doesn't throw
    });
  });

  describe("injectGitignore", () => {
    it("creates .gitignore with the storage entry if the file doesn't exist", async () => {
      const storage = join(workRoot, ".device-use");
      await injectGitignore(workRoot, storage);
      const content = await readFile(join(workRoot, ".gitignore"), "utf8");
      expect(content).toBe(".device-use/\n");
    });

    it("appends to an existing .gitignore with a trailing newline preserved", async () => {
      await writeFile(join(workRoot, ".gitignore"), "node_modules\ndist\n", "utf8");
      await injectGitignore(workRoot, join(workRoot, ".deus/apps/foo"));
      const content = await readFile(join(workRoot, ".gitignore"), "utf8");
      expect(content).toBe("node_modules\ndist\n.deus/apps/foo/\n");
    });

    it("appends with a leading newline when the existing file lacks one", async () => {
      await writeFile(join(workRoot, ".gitignore"), "node_modules", "utf8");
      await injectGitignore(workRoot, join(workRoot, ".cache"));
      const content = await readFile(join(workRoot, ".gitignore"), "utf8");
      expect(content).toBe("node_modules\n.cache/\n");
    });

    it("is idempotent: skips if the entry already exists (with trailing slash)", async () => {
      await writeFile(join(workRoot, ".gitignore"), ".device-use/\n", "utf8");
      await injectGitignore(workRoot, join(workRoot, ".device-use"));
      const content = await readFile(join(workRoot, ".gitignore"), "utf8");
      expect(content).toBe(".device-use/\n");
    });

    it("is idempotent: skips if the entry already exists (no trailing slash)", async () => {
      await writeFile(join(workRoot, ".gitignore"), ".cache\n", "utf8");
      await injectGitignore(workRoot, join(workRoot, ".cache"));
      const content = await readFile(join(workRoot, ".gitignore"), "utf8");
      // Should be unchanged.
      expect(content).toBe(".cache\n");
    });

    it("is a no-op when storage path escapes the workspace", async () => {
      await injectGitignore(workRoot, join(tmpdir(), "somewhere-else"));
      expect(existsSync(join(workRoot, ".gitignore"))).toBe(false);
    });

    it("is a no-op when storage path equals the workspace root", async () => {
      await injectGitignore(workRoot, workRoot);
      expect(existsSync(join(workRoot, ".gitignore"))).toBe(false);
    });
  });
});
