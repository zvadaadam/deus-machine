import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { load } = require("js-yaml") as { load: (text: string) => unknown };

describe("release workflow", () => {
  const workflow = readFileSync(path.join(process.cwd(), ".github/workflows/release.yml"), "utf8");

  it("passes macOS simulator helper paths before lipo -verify_arch flags", () => {
    const lipoVerifyLines = workflow
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("lipo ") && line.includes("-verify_arch"));

    expect(lipoVerifyLines).toContain(
      'lipo "$resources_dir/simulator/simbridge" -verify_arch arm64 x86_64'
    );
    expect(lipoVerifyLines).toContain(
      'lipo "$resources_dir/simulator/siminspector.dylib" -verify_arch arm64 x86_64'
    );
    expect(lipoVerifyLines).not.toContain(
      'lipo -verify_arch arm64 x86_64 "$resources_dir/simulator/simbridge"'
    );
    expect(lipoVerifyLines).not.toContain(
      'lipo -verify_arch arm64 x86_64 "$resources_dir/simulator/siminspector.dylib"'
    );
  });

  const parsed = load(workflow) as {
    jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
  };
  const resolveVersion = parsed.jobs["validate-and-bump"].steps.find(
    (step) => step.name === "Resolve release version"
  )!.run!;
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function resolve(options: { tag?: string; cliVersion?: string; bump?: string }) {
    const context = path.join(process.cwd(), ".context");
    mkdirSync(context, { recursive: true });
    const root = mkdtempSync(path.join(context, "release-version-test-"));
    tempRoots.push(root);
    mkdirSync(path.join(root, "apps/cli"), { recursive: true });
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "0.3.10" }));
    writeFileSync(
      path.join(root, "apps/cli/package.json"),
      JSON.stringify({ version: options.cliVersion ?? "0.3.10" })
    );
    const output = path.join(root, "output");
    writeFileSync(output, "");
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", resolveVersion], {
      cwd: root,
      env: {
        ...process.env,
        GITHUB_REF_TYPE: options.tag ? "tag" : "branch",
        GITHUB_REF_NAME: options.tag ?? "main",
        GITHUB_OUTPUT: output,
        BUMP: options.bump ?? "patch",
        DRY_RUN: "true",
      },
      encoding: "utf8",
    });
    return { ...result, output: readFileSync(output, "utf8") };
  }

  it("releases the pushed tag without incrementing it", () => {
    const result = resolve({ tag: "v0.3.10" });
    expect(result.status).toBe(0);
    expect(result.output).toBe("version=0.3.10\ntag=v0.3.10\n");
  });

  it.each([
    { tag: "v0.3.11" },
    { tag: "v0.3.10", cliVersion: "0.3.9" },
    { tag: "v0.3.10-rc.1" },
    { tag: "v0.3.10;echo unexpected" },
  ])("rejects a mismatched or non-stable tag: %j", (options) => {
    const result = resolve(options);
    expect(result.status).not.toBe(0);
    expect(result.output).toBe("");
  });

  it.each([
    ["patch", "0.3.11"],
    ["minor", "0.4.0"],
    ["major", "1.0.0"],
  ])("keeps the manual %s release path", (bump, version) => {
    const result = resolve({ bump });
    expect(result.status).toBe(0);
    expect(result.output).toBe(`version=${version}\ntag=v${version}\n`);
  });
});
