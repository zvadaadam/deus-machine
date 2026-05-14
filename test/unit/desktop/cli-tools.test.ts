import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { mockSyncShellEnvironment } = vi.hoisted(() => ({
  mockSyncShellEnvironment: vi.fn(async () => undefined),
}));

vi.mock("../../../apps/desktop/main/shell-env", () => ({
  syncShellEnvironment: mockSyncShellEnvironment,
}));

import { checkCliTool, getCliLookupEnv } from "../../../apps/desktop/main/cli-tools";
import { configurePackagedMainRuntimeEnv } from "../../../apps/desktop/main/runtime-env";

const originalBundledBinDir = process.env.DEUS_BUNDLED_BIN_DIR;
const originalDeusPackaged = process.env.DEUS_PACKAGED;
const originalDeusRuntime = process.env.DEUS_RUNTIME;
const originalDeusRuntimeExecutable = process.env.DEUS_RUNTIME_EXECUTABLE;
const originalPath = process.env.PATH;
const originalNodePath = process.env.NODE_PATH;
const originalElectronRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
const tempRoots: string[] = [];

function createTempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "deus-desktop-cli-tools-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  mockSyncShellEnvironment.mockClear();
  if (originalBundledBinDir === undefined) delete process.env.DEUS_BUNDLED_BIN_DIR;
  else process.env.DEUS_BUNDLED_BIN_DIR = originalBundledBinDir;
  if (originalDeusPackaged === undefined) delete process.env.DEUS_PACKAGED;
  else process.env.DEUS_PACKAGED = originalDeusPackaged;
  if (originalDeusRuntime === undefined) delete process.env.DEUS_RUNTIME;
  else process.env.DEUS_RUNTIME = originalDeusRuntime;
  if (originalDeusRuntimeExecutable === undefined) delete process.env.DEUS_RUNTIME_EXECUTABLE;
  else process.env.DEUS_RUNTIME_EXECUTABLE = originalDeusRuntimeExecutable;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalNodePath === undefined) delete process.env.NODE_PATH;
  else process.env.NODE_PATH = originalNodePath;
  if (originalElectronRunAsNode === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
  else process.env.ELECTRON_RUN_AS_NODE = originalElectronRunAsNode;
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("desktop CLI tools", () => {
  it("uses deterministic packaged PATH for native CLI commands", () => {
    process.env.DEUS_PACKAGED = "1";
    process.env.DEUS_BUNDLED_BIN_DIR = "/Applications/Deus.app/Contents/Resources/bin";
    process.env.DEUS_RUNTIME_EXECUTABLE = "/tmp/stale-runtime";
    process.env.ELECTRON_RUN_AS_NODE = "1";
    process.env.NODE_PATH = "/tmp/stale-node-modules";
    process.env.PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin";

    const env = getCliLookupEnv();
    expect(env.PATH).toBe(
      "/Applications/Deus.app/Contents/Resources/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    );
    expect(env.DEUS_PACKAGED).toBeUndefined();
    expect(env.DEUS_BUNDLED_BIN_DIR).toBeUndefined();
    expect(env.DEUS_RUNTIME_EXECUTABLE).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.NODE_PATH).toBeUndefined();
  });

  it.each(["codex", "claude", "gh", "rg", "agent-browser"])(
    "does not fall back to shell/global lookup for packaged bundled tool %s",
    async (tool) => {
      process.env.DEUS_PACKAGED = "1";
      process.env.DEUS_BUNDLED_BIN_DIR = "/missing";
      process.env.PATH = "/opt/homebrew/bin:/usr/bin";

      await expect(checkCliTool(tool)).resolves.toEqual({ installed: false, path: null });
      expect(mockSyncShellEnvironment).not.toHaveBeenCalled();
    }
  );

  it("uses packaged Electron main env without requiring inherited DEUS_PACKAGED", async () => {
    configurePackagedMainRuntimeEnv({
      isPackaged: true,
      platform: "darwin",
      resourcesPath: "/Applications/Deus.app/Contents/Resources",
    });
    process.env.PATH = "/Applications/Deus.app/Contents/Resources/bin:/usr/bin:/bin:/usr/sbin:/sbin";

    await expect(checkCliTool("gh")).resolves.toEqual({ installed: false, path: null });
    expect(mockSyncShellEnvironment).not.toHaveBeenCalled();
  });

  it.each(["codex", "claude", "gh", "rg", "agent-browser"])(
    "resolves packaged bundled tool %s from the bundled bin directory",
    async (tool) => {
      const root = createTempRoot();
      const binDir = path.join(root, "bin");
      const toolPath = path.join(binDir, tool);
      mkdirSync(binDir, { recursive: true });
      writeFileSync(toolPath, "");
      chmodSync(toolPath, 0o755);
      process.env.DEUS_PACKAGED = "1";
      process.env.DEUS_BUNDLED_BIN_DIR = binDir;

      await expect(checkCliTool(tool)).resolves.toEqual({ installed: true, path: toolPath });
    }
  );
});
