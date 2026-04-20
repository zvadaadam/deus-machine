import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __clearRegistryCacheForTests,
  getInstalledApp,
  loadInstalledApps,
  readAppSkills,
} from "../../../../src/services/aap/registry";

describe("aap/registry", () => {
  beforeEach(() => {
    // Ensure the hardcoded manifest path resolves relative to the repo root,
    // which is vitest's cwd when running from the backend package via the
    // root-level `bun run test:backend` script.
    __clearRegistryCacheForTests();
  });

  afterEach(() => {
    __clearRegistryCacheForTests();
  });

  it("loads the device-use manifest from the hardcoded list", () => {
    const apps = loadInstalledApps();
    expect(apps.length).toBeGreaterThan(0);

    const deviceUse = apps.find((a) => a.manifest.id === "deus.mobile-use");
    expect(deviceUse).toBeDefined();
    expect(deviceUse?.manifest.name).toBe("Mobile Use");
    expect(deviceUse?.manifest.launch.command).toBe("device-use");
    expect(deviceUse?.packageRoot.endsWith("packages/device-use")).toBe(true);
  });

  it("caches results across calls", () => {
    const a = loadInstalledApps();
    const b = loadInstalledApps();
    expect(a).toBe(b);
  });

  it("getInstalledApp returns the matching entry by id", () => {
    const app = getInstalledApp("deus.mobile-use");
    expect(app?.manifest.id).toBe("deus.mobile-use");
  });

  it("getInstalledApp returns undefined for an unknown id", () => {
    const app = getInstalledApp("not.a.real-app");
    expect(app).toBeUndefined();
  });

  it("readAppSkills returns the concatenated skill files declared in the manifest", () => {
    const app = getInstalledApp("deus.mobile-use")!;
    expect(app.manifest.skills.length).toBeGreaterThan(0);
    const content = readAppSkills(app);
    // Divider and path prefix are produced by readAppSkills itself.
    expect(content).toContain("# skills/device-use/SKILL.md");
    // Sanity: first line of the file's frontmatter survives the read.
    expect(content).toContain("name: device-use");
  });

  it("readAppSkills returns empty string when manifest declares no skills", () => {
    // Synthesize a manifest entry with no skills. Bypasses the registry so
    // we exercise readAppSkills purely as a function.
    const entry = {
      manifest: { skills: [] as string[] },
      manifestPath: "/tmp/x",
      packageRoot: "/tmp",
    } as Parameters<typeof readAppSkills>[0];
    expect(readAppSkills(entry)).toBe("");
  });
});
