import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
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
const TEST_GH_VERSION = "test";
const TEST_GH_TARGETS = [
  {
    runtimeKey: "darwin-arm64",
    fileArch: "arm64",
    archivePlatform: "macOS_arm64",
    archiveSha256: "test-arm64",
  },
  {
    runtimeKey: "darwin-x64",
    fileArch: "x86_64",
    archivePlatform: "macOS_amd64",
    archiveSha256: "test-x64",
  },
];

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
  writeFile(
    path.join(projectRoot, "scripts", "runtime", "gh-cli-contract.json"),
    JSON.stringify({ ghVersion: TEST_GH_VERSION, targets: TEST_GH_TARGETS }, null, 2)
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
  for (const target of TEST_GH_TARGETS) {
    const runtimeKey = target.runtimeKey;
    const ghPath = path.join(projectRoot, "dist", "runtime", "electron", "bin", runtimeKey, "gh");
    const relativeGhPath = path.relative(projectRoot, ghPath).split(path.sep).join("/");
    writeExecutable(ghPath, "gh");
    const archiveName = `gh_${TEST_GH_VERSION}_${target.archivePlatform}.zip`;
    targets.push({
      tool: "gh",
      runtimeKey,
      path: relativeGhPath,
      sha256: createHash("sha256").update("gh").digest("hex"),
      size: 2,
      fileOutput: `${relativeGhPath}: Mach-O 64-bit executable ${target.fileArch}`,
      source: {
        version: TEST_GH_VERSION,
        archiveName,
        archiveSha256: target.archiveSha256,
        url: `https://github.com/cli/cli/releases/download/v${TEST_GH_VERSION}/${archiveName}`,
      },
    });
  }
  writeFile(
    path.join(projectRoot, "dist", "runtime", "electron", "bin", "gh-cli.json"),
    JSON.stringify({ version: 1, ghVersion: TEST_GH_VERSION, targets }, null, 2)
  );
}

beforeEach(() => {
  validateDeusRuntimeMock.mockReset();
  validateStagedAgentClisMock.mockReset();
  execFileSyncMock.mockReset();
  execFileSyncMock.mockImplementation((command: string, args: string[]) => {
    if (command === "file") {
      const targetPath = args[0] ?? "";
      const arch = targetPath.includes("darwin-x64") ? "x86_64" : "arm64";
      return `${targetPath}: Mach-O 64-bit executable ${arch}`;
    }
    if (command === "codesign") return "";
    throw new Error(`Unexpected execFileSync call: ${command} ${args.join(" ")}`);
  });
});

afterEach(() => {
  if (originalVerifyRuntimeRunnable === undefined) delete process.env.DEUS_VERIFY_RUNTIME_RUNNABLE;
  else process.env.DEUS_VERIFY_RUNTIME_RUNNABLE = originalVerifyRuntimeRunnable;
  for (const projectRoot of tempRoots.splice(0)) {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

describe("validateRuntimeStage", () => {
  it("can restage shared bundles without deleting packaged runtime artifacts", () => {
    const projectRoot = createTempProjectRoot();
    writeProjectFixture(projectRoot);

    stageRuntime({ projectRoot, log: () => {} });
    const nativeRuntimeManifest = path.join(
      projectRoot,
      "dist",
      "runtime",
      "electron",
      "bin",
      "deus-runtime.json"
    );
    writeFile(nativeRuntimeManifest, "native-runtime");

    stageRuntime({ projectRoot, log: () => {}, preserveElectron: true });

    expect(readFileSync(nativeRuntimeManifest, "utf8")).toBe("native-runtime");
    expect(
      existsSync(path.join(projectRoot, "dist", "runtime", "common", "server.bundled.cjs"))
    ).toBe(true);
  });

  it("accepts a freshly staged runtime", () => {
    const projectRoot = createTempProjectRoot();
    writeProjectFixture(projectRoot);

    stageRuntime({ projectRoot, log: () => {} });
    writeGhFixtures(projectRoot);

    expect(() => validateRuntimeStage({ projectRoot, log: () => {} })).not.toThrow();
    expect(validateDeusRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({ projectRoot, verifyRunnable: false })
    );
    expect(validateDeusRuntimeMock).toHaveBeenCalledOnce();
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
    expect(validateDeusRuntimeMock).toHaveBeenCalledOnce();
  });

  it("fails when the staged GitHub CLI is missing", () => {
    const projectRoot = createTempProjectRoot();
    writeProjectFixture(projectRoot);

    stageRuntime({ projectRoot, log: () => {} });
    writeGhFixtures(projectRoot);
    rmSync(path.join(projectRoot, "dist", "runtime", "electron", "bin", "darwin-arm64", "gh"), {
      force: true,
    });

    expect(() => validateRuntimeStage({ projectRoot, log: () => {} })).toThrow(
      /Missing darwin-arm64\/gh/
    );
  });

  it("fails when the staged GitHub CLI is a directory", () => {
    const projectRoot = createTempProjectRoot();
    writeProjectFixture(projectRoot);

    stageRuntime({ projectRoot, log: () => {} });
    writeGhFixtures(projectRoot);
    const ghPath = path.join(
      projectRoot,
      "dist",
      "runtime",
      "electron",
      "bin",
      "darwin-arm64",
      "gh"
    );
    rmSync(ghPath, { force: true });
    mkdirSync(ghPath);
    chmodSync(ghPath, 0o755);

    expect(() => validateRuntimeStage({ projectRoot, log: () => {} })).toThrow(
      /Expected darwin-arm64\/gh to be a regular file/
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
