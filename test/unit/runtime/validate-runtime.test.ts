import { chmodSync, mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLI_RUNTIME_DEPENDENCIES } from "@shared/runtime";
import { stageRuntime } from "../../../scripts/runtime/stage";
import { validateRuntimeStage } from "../../../scripts/runtime/validate";

const validateDeusRuntimeMock = vi.hoisted(() => vi.fn());
const validateStagedAgentClisMock = vi.hoisted(() => vi.fn());
const execFileSyncMock = vi.hoisted(() =>
  vi.fn((command: string, args: string[]) => {
    if (command === "file") {
      const targetPath = args[0] ?? "";
      const arch = targetPath.includes("darwin-x64") ? "x86_64" : "arm64";
      return `${targetPath}: Mach-O 64-bit executable ${arch}`;
    }
    if (command === "codesign") return "";
    throw new Error(`Unexpected execFileSync call: ${command} ${args.join(" ")}`);
  })
);

vi.mock("../../../scripts/runtime/native-runtime", () => ({
  validateDeusRuntime: validateDeusRuntimeMock,
}));

vi.mock("../../../scripts/runtime/agent-clis", () => ({
  validateStagedAgentClis: validateStagedAgentClisMock,
}));

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
}));

const tempRoots: string[] = [];
const originalVerifyRuntimeRunnable = process.env.DEUS_VERIFY_RUNTIME_RUNNABLE;

function createTempProjectRoot(): string {
  const projectRoot = mkdtempSync(path.join(os.tmpdir(), "deus-runtime-validate-"));
  tempRoots.push(projectRoot);
  return projectRoot;
}

function writeFile(filePath: string, contents: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
}

function writeExecutable(filePath: string, contents: string): void {
  writeFile(filePath, contents);
  chmodSync(filePath, 0o755);
}

function writeProjectFixture(projectRoot: string): void {
  writeFile(path.join(projectRoot, "apps", "backend", "dist", "server.bundled.cjs"), "backend");
  writeFile(
    path.join(projectRoot, "apps", "agent-server", "dist", "index.bundled.cjs"),
    "agent-server"
  );
  writeFile(
    path.join(projectRoot, "apps", "cli", "package.json"),
    JSON.stringify(
      {
        name: "deus-cli-fixture",
        dependencies: Object.fromEntries(
          CLI_RUNTIME_DEPENDENCIES.map((dependency) => [dependency, "1.0.0"])
        ),
      },
      null,
      2
    )
  );

  const claudePackage =
    process.platform === "linux"
      ? `@anthropic-ai/claude-agent-sdk-linux-${process.arch}`
      : `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  const codexPackage =
    process.platform === "linux"
      ? `@openai/codex-linux-${process.arch}`
      : `@openai/codex-darwin-${process.arch}`;
  const codexTriple =
    process.platform === "linux"
      ? process.arch === "arm64"
        ? "aarch64-unknown-linux-musl"
        : "x86_64-unknown-linux-musl"
      : process.arch === "arm64"
        ? "aarch64-apple-darwin"
        : "x86_64-apple-darwin";

  writeExecutable(path.join(projectRoot, "node_modules", claudePackage, "claude"), "claude");
  writeExecutable(
    path.join(projectRoot, "node_modules", codexPackage, "vendor", codexTriple, "codex", "codex"),
    "codex"
  );
}

function writeGhFixtures(projectRoot: string): void {
  const targets = [];
  for (const runtimeKey of ["darwin-arm64", "darwin-x64"]) {
    const ghPath = path.join(projectRoot, "dist", "runtime", "electron", "bin", runtimeKey, "gh");
    writeExecutable(ghPath, "gh");
    const fileArch = runtimeKey === "darwin-x64" ? "x86_64" : "arm64";
    targets.push({
      tool: "gh",
      runtimeKey,
      path: path.relative(projectRoot, ghPath).split(path.sep).join("/"),
      sha256: createHash("sha256").update("gh").digest("hex"),
      size: 2,
      fileOutput: `${ghPath}: Mach-O 64-bit executable ${fileArch}`,
      source: {
        version: "test",
        archiveName: "test.zip",
        archiveSha256: "test",
        url: "https://example.invalid/test.zip",
      },
    });
  }
  writeFile(
    path.join(projectRoot, "dist", "runtime", "electron", "bin", "gh-cli.json"),
    JSON.stringify({ version: 1, ghVersion: "test", targets }, null, 2)
  );
}

beforeEach(() => {
  validateDeusRuntimeMock.mockReset();
  validateStagedAgentClisMock.mockReset();
  execFileSyncMock.mockClear();
});

afterEach(() => {
  if (originalVerifyRuntimeRunnable === undefined) delete process.env.DEUS_VERIFY_RUNTIME_RUNNABLE;
  else process.env.DEUS_VERIFY_RUNTIME_RUNNABLE = originalVerifyRuntimeRunnable;
  for (const projectRoot of tempRoots.splice(0)) {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

describe("validateRuntimeStage", () => {
  it("accepts a freshly staged runtime", () => {
    const projectRoot = createTempProjectRoot();
    writeProjectFixture(projectRoot);

    stageRuntime({ projectRoot, log: () => {} });
    writeGhFixtures(projectRoot);

    expect(() => validateRuntimeStage({ projectRoot, log: () => {} })).not.toThrow();
    expect(validateDeusRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({ projectRoot, verifyRunnable: false })
    );
    expect(validateStagedAgentClisMock).toHaveBeenCalledOnce();
  });

  it("can require runnable native runtime validation when requested", () => {
    const projectRoot = createTempProjectRoot();
    writeProjectFixture(projectRoot);
    stageRuntime({ projectRoot, log: () => {} });
    writeGhFixtures(projectRoot);
    process.env.DEUS_VERIFY_RUNTIME_RUNNABLE = "1";

    expect(() => validateRuntimeStage({ projectRoot, log: () => {} })).not.toThrow();
    expect(validateDeusRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({ projectRoot, verifyRunnable: true })
    );
  });

  it("fails when the staged GitHub CLI is missing", () => {
    const projectRoot = createTempProjectRoot();
    writeProjectFixture(projectRoot);

    stageRuntime({ projectRoot, log: () => {} });

    expect(() => validateRuntimeStage({ projectRoot, log: () => {} })).toThrow(
      /Missing darwin-arm64\/gh/
    );
  });

  it("fails when the staged runtime is older than the source bundles", () => {
    const projectRoot = createTempProjectRoot();
    writeProjectFixture(projectRoot);

    stageRuntime({ projectRoot, log: () => {} });

    const backendSource = path.join(projectRoot, "apps", "backend", "dist", "server.bundled.cjs");
    const futureTime = new Date(Date.now() + 5_000);
    utimesSync(backendSource, futureTime, futureTime);

    expect(() => validateRuntimeStage({ projectRoot, log: () => {} })).toThrow(
      /Run `bun run build:runtime` before packaging\./
    );
  });
});
