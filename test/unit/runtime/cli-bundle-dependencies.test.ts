import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertCliBundleDependencies } from "../../../scripts/runtime/stage";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function cliFixture(files: Record<string, string>, dependencies: Record<string, string> = {}) {
  const cliDir = mkdtempSync(path.join(os.tmpdir(), "deus-cli-deps-"));
  roots.push(cliDir);
  writeFileSync(
    path.join(cliDir, "package.json"),
    JSON.stringify({ files: ["bin/", "dist/", "bundles/"], dependencies })
  );
  for (const [relative, contents] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(cliDir, relative)), { recursive: true });
    writeFileSync(path.join(cliDir, relative), contents);
  }
  return cliDir;
}

describe("assertCliBundleDependencies", () => {
  it("accepts Node builtins and declared packages, in ESM and CommonJS", () => {
    const cliDir = cliFixture(
      {
        "bin/deus.js": 'import "../dist/cli.js";\n',
        "dist/cli.js": [
          'import { join } from "node:path";',
          'import fs from "fs";',
          'import { WebSocket } from "ws";',
          "console.log(join, fs, WebSocket);",
        ].join("\n"),
        "bundles/server.bundled.cjs": [
          'const os = require("os");',
          'const Sentry = require("@sentry/node/preload");',
          "module.exports = { os, Sentry };",
        ].join("\n"),
      },
      { ws: "^8.0.0", "@sentry/node": "^10.0.0" }
    );
    const lines: string[] = [];
    expect(() => assertCliBundleDependencies(cliDir, (line) => lines.push(line))).not.toThrow();
    expect(lines).toEqual([
      "✓ What the CLI imports as it loads is Node's or a declared dependency (3 files)",
    ]);
  });

  it("fails on a package the CLI imports at load time but does not declare", () => {
    // The 0.3.12 bundle: a build script pulled the engine into dist/cli.js.
    const cliDir = cliFixture({
      "bin/deus.js": 'import "../dist/cli.js";\n',
      "dist/cli.js": [
        'import { DEFAULT_PINS } from "@zvada/agent-server/core";',
        'import { runInstall } from "@zvada/agent-server/server";',
        "console.log(DEFAULT_PINS, runInstall);",
      ].join("\n"),
    });
    expect(() => assertCliBundleDependencies(cliDir, () => {})).toThrow(
      /does not declare: @zvada\/agent-server \(from .*dist\/cli\.js\)/
    );
  });

  it("fails on an undeclared require in the published backend bundle", () => {
    const cliDir = cliFixture({
      "dist/cli.js": "export {};\n",
      "bundles/server.bundled.cjs": 'module.exports = require("hono");\n',
    });
    expect(() => assertCliBundleDependencies(cliDir, () => {})).toThrow(/does not declare: hono/);
  });

  it("fails on a published file Node cannot parse", () => {
    // What 0.3.11 and 0.3.12 shipped: `import.meta` in a CommonJS bundle.
    const cliDir = cliFixture({
      "dist/cli.js": "export {};\n",
      "bundles/server.bundled.cjs":
        'const requireModule = require("node:module").createRequire(import.meta.url);\n',
    });
    expect(() => assertCliBundleDependencies(cliDir, () => {})).toThrow(
      /Node cannot parse bundles\/server\.bundled\.cjs:[\s\S]*import\.meta/
    );
  });

  it("reports an undeclared dynamic import without failing", () => {
    const cliDir = cliFixture({
      "dist/cli.js": 'export const load = () => import("device-use/engine");\n',
    });
    const lines: string[] = [];
    expect(() => assertCliBundleDependencies(cliDir, (line) => lines.push(line))).not.toThrow();
    expect(lines[0]).toMatch(/only when used: device-use \(from .*dist\/cli\.js\)/);
  });
});
