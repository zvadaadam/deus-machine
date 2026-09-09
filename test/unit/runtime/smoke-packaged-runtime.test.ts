import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../../..");
const require = createRequire(import.meta.url);
const { pathPattern } = require("../../../scripts/runtime/smoke/lib/smoke-helpers.cjs");

describe("packaged runtime smoke harness", () => {
  it("recognizes a CLI alias when the app's parent directory is resolved", () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "deus-smoke-path-")));
    try {
      const binDir = path.join(root, "real-bundle");
      const aliasDir = path.join(root, "bundle");
      const executable = path.join(binDir, "codex-runtime", "bin", "codex");
      mkdirSync(path.dirname(executable), { recursive: true });
      writeFileSync(executable, "codex");
      symlinkSync(binDir, aliasDir, "dir");
      symlinkSync("codex-runtime/bin/codex", path.join(binDir, "codex"));

      const pattern = new RegExp(`^${pathPattern(path.join(aliasDir, "codex"))}$`);
      expect(pattern.test(path.join(aliasDir, "codex"))).toBe(true);
      expect(pattern.test(path.join(binDir, "codex"))).toBe(true);
      expect(pattern.test(executable)).toBe(true);
      expect(pattern.test(path.join(root, "global", "codex"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not load host better-sqlite3 to seed backend state", () => {
    const script = readFileSync(
      path.join(projectRoot, "scripts", "runtime", "smoke", "packaged-runtime.cjs"),
      "utf8"
    );

    expect(script).not.toMatch(/require\(["']better-sqlite3["']\)/);
    expect(script).not.toMatch(/new\s+Database\s*\(/);
    expect(script).toContain('POST", "/api/repos"');
    expect(script).toContain('POST", "/api/workspaces"');
  });
});
