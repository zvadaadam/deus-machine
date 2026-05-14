import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  assertElectronBuildVersion,
  assertPackagedMainRuntimeContract,
  assertPackagedRuntimePlatform,
} = require("../../../scripts/runtime/electron-builder-before-pack.cjs") as {
  assertElectronBuildVersion: (projectRoot: string) => void;
  assertPackagedMainRuntimeContract: (projectRoot: string) => void;
  assertPackagedRuntimePlatform: (context?: { electronPlatformName?: string }) => void;
};

const tempRoots: string[] = [];
const packagedRuntimeDenylist = [
  "AGENT_SERVER_CWD",
  "AGENT_SERVER_ENTRY",
  "AUTH_TOKEN",
  "BUN_OPTIONS",
  "DATABASE_PATH",
  "DEUS_AUTH_TOKEN",
  "DEUS_BUNDLED_BIN_DIR",
  "DEUS_BACKEND_PORT",
  "DEUS_DATA_DIR",
  "ELECTRON_RUN_AS_NODE",
  "DEUS_PACKAGED",
  "DEUS_RESOURCES_PATH",
  "DEUS_RUNTIME",
  "DEUS_RUNTIME_COMMAND",
  "DEUS_RUNTIME_EXECUTABLE",
  "NODE_PATH",
  "PORT",
];

function createProjectWithMainOutput(contents: string): string {
  const projectRoot = mkdtempSync(path.join(os.tmpdir(), "deus-before-pack-"));
  tempRoots.push(projectRoot);
  const mainOutput = path.join(projectRoot, "out", "main", "index.js");
  mkdirSync(path.dirname(mainOutput), { recursive: true });
  writeFileSync(mainOutput, contents);
  return projectRoot;
}

function createProjectWithRendererVersion(
  packageVersion: string,
  rendererContents: string
): string {
  const projectRoot = mkdtempSync(path.join(os.tmpdir(), "deus-before-pack-"));
  tempRoots.push(projectRoot);
  writeFileSync(
    path.join(projectRoot, "package.json"),
    JSON.stringify({ version: packageVersion })
  );
  const rendererOutput = path.join(projectRoot, "out", "renderer", "assets", "index.js");
  mkdirSync(path.dirname(rendererOutput), { recursive: true });
  writeFileSync(rendererOutput, rendererContents);
  return projectRoot;
}

function packagedRuntimeContractOutput(extraLines: string[] = []): string {
  return [
    "function configurePackagedMainRuntimeEnv(options) { process.env.DEUS_PACKAGED = '1'; }",
    "configurePackagedMainRuntimeEnv({ isPackaged: app.isPackaged });",
    `const PACKAGED_RUNTIME_ENV_DENYLIST = ${JSON.stringify(packagedRuntimeDenylist)};`,
    "for (const key of PACKAGED_RUNTIME_ENV_DENYLIST) delete childEnv[key];",
    'const runtimeExecutable = join(process.resourcesPath, "bin", "deus-runtime");',
    "const env = { DEUS_RUNTIME_EXECUTABLE: runtimeExecutable };",
    'const backendArgs = runtime.runtimeExecutable ? ["backend"] : [runtime.backendEntry];',
    'const PACKAGED_BUNDLED_TOOLS = new Set(["codex", "claude", "gh", "rg", "agent-browser"]);',
    "const CLI_CHILD_ENV_DENYLIST = PACKAGED_RUNTIME_ENV_DENYLIST;",
    'const PACKAGED_TERMINAL_TOOLS = new Set(["claude", "codex", "gh", "rg"]);',
    ...extraLines,
  ].join("\n");
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("electron-builder beforePack runtime guard", () => {
  it("allows macOS packaging where native runtime binaries are staged", () => {
    expect(() => assertPackagedRuntimePlatform({ electronPlatformName: "darwin" })).not.toThrow();
  });

  it("rejects non-macOS packaging until native runtime binaries are staged", () => {
    expect(() => assertPackagedRuntimePlatform({ electronPlatformName: "linux" })).toThrow(
      /native runtime is currently staged only for macOS/
    );
  });

  it("accepts Electron main output with the packaged deus-runtime contract", () => {
    const projectRoot = createProjectWithMainOutput(packagedRuntimeContractOutput());

    expect(() => assertPackagedMainRuntimeContract(projectRoot)).not.toThrow();
  });

  it("rejects Electron main output missing the packaged deus-runtime contract", () => {
    const projectRoot = createProjectWithMainOutput("console.log('backend');");

    expect(() => assertPackagedMainRuntimeContract(projectRoot)).toThrow(
      /does not contain packaged runtime contract snippet/
    );
  });

  it("rejects obsolete packaged backend bundle paths", () => {
    const projectRoot = createProjectWithMainOutput(
      packagedRuntimeContractOutput([
        'const backendEntry = join(process.resourcesPath, "backend", "server.bundled.cjs");',
      ])
    );

    expect(() => assertPackagedMainRuntimeContract(projectRoot)).toThrow(
      /obsolete packaged backend bundle path/
    );
  });

  it("rejects obsolete packaged NODE_PATH plumbing", () => {
    const projectRoot = createProjectWithMainOutput(
      packagedRuntimeContractOutput([
        "const env = { DEUS_RUNTIME_EXECUTABLE: runtimeExecutable, NODE_PATH: runtime.nodePath };",
      ])
    );

    expect(() => assertPackagedMainRuntimeContract(projectRoot)).toThrow(
      /obsolete packaged NODE_PATH plumbing/
    );
  });

  it("rejects stale Electron main output missing packaged main env initialization", () => {
    const projectRoot = createProjectWithMainOutput(
      [
        'const runtimeExecutable = join(process.resourcesPath, "bin", "deus-runtime");',
        "const env = { DEUS_RUNTIME_EXECUTABLE: runtimeExecutable };",
        'const backendArgs = runtime.runtimeExecutable ? ["backend"] : [runtime.backendEntry];',
      ].join("\n")
    );

    expect(() => assertPackagedMainRuntimeContract(projectRoot)).toThrow(
      /configurePackagedMainRuntimeEnv/
    );
  });

  it("rejects stale Electron main output missing backend env scrub denylist", () => {
    const projectRoot = createProjectWithMainOutput(
      [
        "function configurePackagedMainRuntimeEnv(options) { process.env.DEUS_PACKAGED = '1'; }",
        "configurePackagedMainRuntimeEnv({ isPackaged: app.isPackaged });",
        'const runtimeExecutable = join(process.resourcesPath, "bin", "deus-runtime");',
        "const env = { DEUS_RUNTIME_EXECUTABLE: runtimeExecutable };",
        'const backendArgs = runtime.runtimeExecutable ? ["backend"] : [runtime.backendEntry];',
      ].join("\n")
    );

    expect(() => assertPackagedMainRuntimeContract(projectRoot)).toThrow(
      /PACKAGED_RUNTIME_ENV_DENYLIST/
    );
  });

  it("rejects stale Electron main output with incomplete runtime env scrub denylist", () => {
    const staleDenylist = packagedRuntimeDenylist.filter(
      (key) => key !== "ELECTRON_RUN_AS_NODE" && key !== "NODE_PATH"
    );
    const projectRoot = createProjectWithMainOutput(
      packagedRuntimeContractOutput().replace(
        JSON.stringify(packagedRuntimeDenylist),
        JSON.stringify(staleDenylist)
      )
    );

    expect(() => assertPackagedMainRuntimeContract(projectRoot)).toThrow(/ELECTRON_RUN_AS_NODE/);
  });

  it("rejects stale Electron main output missing packaged CLI lookup guards", () => {
    const projectRoot = createProjectWithMainOutput(
      [
        "function configurePackagedMainRuntimeEnv(options) { process.env.DEUS_PACKAGED = '1'; }",
        "configurePackagedMainRuntimeEnv({ isPackaged: app.isPackaged });",
        `const PACKAGED_RUNTIME_ENV_DENYLIST = ${JSON.stringify(packagedRuntimeDenylist)};`,
        "for (const key of PACKAGED_RUNTIME_ENV_DENYLIST) delete childEnv[key];",
        'const runtimeExecutable = join(process.resourcesPath, "bin", "deus-runtime");',
        "const env = { DEUS_RUNTIME_EXECUTABLE: runtimeExecutable };",
        'const backendArgs = runtime.runtimeExecutable ? ["backend"] : [runtime.backendEntry];',
      ].join("\n")
    );

    expect(() => assertPackagedMainRuntimeContract(projectRoot)).toThrow(/PACKAGED_BUNDLED_TOOLS/);
  });

  it("accepts renderer output containing the current package version", () => {
    const projectRoot = createProjectWithRendererVersion(
      "1.2.3",
      'window.__APP_VERSION__ = "1.2.3";'
    );

    expect(() => assertElectronBuildVersion(projectRoot)).not.toThrow();
  });

  it("rejects renderer output missing the current package version", () => {
    const projectRoot = createProjectWithRendererVersion(
      "1.2.3",
      'window.__APP_VERSION__ = "1.2.2";'
    );

    expect(() => assertElectronBuildVersion(projectRoot)).toThrow(
      /renderer build output does not contain 1\.2\.3/
    );
  });
});
