import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveTerminalCliCommand,
  toAppleScriptString,
} from "../../../apps/desktop/main/terminal-command";
import { configurePackagedMainRuntimeEnv } from "../../../apps/desktop/main/runtime-env";

const originalBundledBinDir = process.env.DEUS_BUNDLED_BIN_DIR;
const originalDeusPackaged = process.env.DEUS_PACKAGED;
const originalDeusRuntime = process.env.DEUS_RUNTIME;
const tempRoots: string[] = [];

function createBundledTool(tool: string): string {
  const root = mkdtempSync(path.join(tmpdir(), "deus-terminal-command-"));
  tempRoots.push(root);
  const binDir = path.join(root, "Contents", "Resources", "bin");
  const toolPath = path.join(binDir, tool);
  mkdirSync(binDir, { recursive: true });
  writeFileSync(toolPath, "");
  chmodSync(toolPath, 0o755);
  process.env.DEUS_BUNDLED_BIN_DIR = binDir;
  return toolPath;
}

afterEach(() => {
  if (originalBundledBinDir === undefined) delete process.env.DEUS_BUNDLED_BIN_DIR;
  else process.env.DEUS_BUNDLED_BIN_DIR = originalBundledBinDir;
  if (originalDeusPackaged === undefined) delete process.env.DEUS_PACKAGED;
  else process.env.DEUS_PACKAGED = originalDeusPackaged;
  if (originalDeusRuntime === undefined) delete process.env.DEUS_RUNTIME;
  else process.env.DEUS_RUNTIME = originalDeusRuntime;
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("terminal command helpers", () => {
  it("quotes simple CLI commands for shell execution", () => {
    expect(resolveTerminalCliCommand("claude login")).toBe("'claude' 'login'");
  });

  it("rejects shell metacharacters", () => {
    expect(resolveTerminalCliCommand("claude login; rm -rf /")).toBeNull();
  });

  it("uses bundled agent CLI paths in packaged runtime", () => {
    const claudePath = createBundledTool("claude");
    process.env.DEUS_PACKAGED = "1";

    expect(resolveTerminalCliCommand("claude login")).toBe(`'${claudePath}' 'login'`);
  });

  it("uses bundled Codex CLI paths in packaged runtime", () => {
    const codexPath = createBundledTool("codex");
    process.env.DEUS_PACKAGED = "1";

    expect(resolveTerminalCliCommand("codex login")).toBe(`'${codexPath}' 'login'`);
  });

  it("does not fall back to global agent CLI names in packaged runtime", () => {
    process.env.DEUS_PACKAGED = "1";
    process.env.DEUS_BUNDLED_BIN_DIR = "/missing";

    expect(resolveTerminalCliCommand("codex login")).toBeNull();
    expect(resolveTerminalCliCommand("claude login")).toBeNull();
  });

  it("uses packaged Electron main env for terminal agent commands", () => {
    const codexPath = createBundledTool("codex");
    configurePackagedMainRuntimeEnv({
      isPackaged: true,
      platform: "darwin",
      resourcesPath: path.dirname(path.dirname(codexPath)),
    });

    expect(resolveTerminalCliCommand("codex login")).toBe(`'${codexPath}' 'login'`);
  });

  it("escapes AppleScript strings", () => {
    expect(toAppleScriptString("'codex' \"login\"")).toBe("\"'codex' \\\"login\\\"\"");
  });
});
