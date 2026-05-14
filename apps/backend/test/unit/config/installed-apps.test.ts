import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempRoots: string[] = [];
const originalCwd = process.cwd();
const originalEnv = { ...process.env };
const originalResourcesPath = (process as { resourcesPath?: string }).resourcesPath;

function createTempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "deus-installed-apps-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  process.chdir(originalCwd);
  process.env = { ...originalEnv };
  if (originalResourcesPath === undefined) {
    delete (process as { resourcesPath?: string }).resourcesPath;
  } else {
    (process as { resourcesPath?: string }).resourcesPath = originalResourcesPath;
  }
  vi.resetModules();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("installed app manifest discovery", () => {
  it("uses DEUS_RESOURCES_PATH under the compiled runtime", async () => {
    const root = createTempRoot();
    const resourcesPath = path.join(root, "Resources");
    const manifestPath = path.join(resourcesPath, "agentic-apps", "device-use", "agentic-app.json");
    mkdirSync(path.dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, "{}");

    process.chdir(root);
    process.env.DEUS_RESOURCES_PATH = resourcesPath;
    delete (process as { resourcesPath?: string }).resourcesPath;
    vi.resetModules();

    const { INSTALLED_APP_MANIFESTS } = await import("../../../src/config/installed-apps");

    expect(INSTALLED_APP_MANIFESTS).toEqual([manifestPath]);
  });
});
