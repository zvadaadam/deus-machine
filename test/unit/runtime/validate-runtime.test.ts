import { chmodSync, mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLI_RUNTIME_DEPENDENCIES } from "@shared/runtime";
import { stageRuntime } from "../../../apps/runtime/stage";
import { validateRuntimeStage } from "../../../apps/runtime/validate";

const tempRoots: string[] = [];

function createTempProjectRoot(): string {
  const projectRoot = mkdtempSync(path.join(os.tmpdir(), "deus-runtime-validate-"));
  tempRoots.push(projectRoot);
  return projectRoot;
}

function writeFile(filePath: string, contents: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
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

  writeFile(path.join(projectRoot, "node_modules", claudePackage, "claude"), "claude");
  writeFile(
    path.join(projectRoot, "node_modules", codexPackage, "vendor", codexTriple, "codex", "codex"),
    "codex"
  );
  chmodSync(path.join(projectRoot, "node_modules", claudePackage, "claude"), 0o755);
  chmodSync(
    path.join(projectRoot, "node_modules", codexPackage, "vendor", codexTriple, "codex", "codex"),
    0o755
  );
}

afterEach(() => {
  for (const projectRoot of tempRoots.splice(0)) {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

describe("validateRuntimeStage", () => {
  it("accepts a freshly staged runtime", () => {
    const projectRoot = createTempProjectRoot();
    writeProjectFixture(projectRoot);

    stageRuntime({ projectRoot, log: () => {} });

    expect(() => validateRuntimeStage({ projectRoot, log: () => {} })).not.toThrow();
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
