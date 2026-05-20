import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../../..");

describe("packaged runtime smoke harness", () => {
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
