import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
