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
const originalPath = process.env.PATH;
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
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("desktop CLI tools", () => {
  it("uses deterministic packaged PATH for native CLI commands", () => {
    process.env.DEUS_PACKAGED = "1";
    process.env.DEUS_BUNDLED_BIN_DIR = "/Applications/Deus.app/Contents/Resources/bin";
    process.env.PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin";

    expect(getCliLookupEnv().PATH).toBe(
      "/Applications/Deus.app/Contents/Resources/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    );
  });

  it("does not fall back to shell/global lookup for packaged bundled tools", async () => {
    process.env.DEUS_PACKAGED = "1";
    process.env.DEUS_BUNDLED_BIN_DIR = "/missing";
    process.env.PATH = "/opt/homebrew/bin:/usr/bin";

    await expect(checkCliTool("gh")).resolves.toEqual({ installed: false, path: null });
    expect(mockSyncShellEnvironment).not.toHaveBeenCalled();
  });

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

  it("resolves packaged bundled tools from the bundled bin directory", async () => {
    const root = createTempRoot();
    const binDir = path.join(root, "bin");
    const ghPath = path.join(binDir, "gh");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(ghPath, "");
    chmodSync(ghPath, 0o755);
    process.env.DEUS_PACKAGED = "1";
    process.env.DEUS_BUNDLED_BIN_DIR = binDir;

    await expect(checkCliTool("gh")).resolves.toEqual({ installed: true, path: ghPath });
  });
});
