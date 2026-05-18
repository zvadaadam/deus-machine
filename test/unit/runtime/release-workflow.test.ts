import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

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

  it("passes Bun's npm publish token environment to the CLI publish step", () => {
    const validateStep = workflow.slice(
      workflow.indexOf("      - name: Validate npm token"),
      workflow.indexOf("      - uses: actions/checkout@v4", workflow.indexOf("  publish-cli:"))
    );
    expect(validateStep).toContain('if [ -z "$NPM_CONFIG_TOKEN" ]; then');
    expect(validateStep).toContain("NPM_CONFIG_TOKEN: ${{ secrets.NPM_TOKEN }}");

    const publishStep = workflow.slice(
      workflow.indexOf("      - name: Publish to npm"),
      workflow.indexOf("  # ── Step 5:", workflow.indexOf("      - name: Publish to npm"))
    );
    expect(publishStep).toContain("printf '//registry.npmjs.org/:_authToken=%s\\n'");
    expect(publishStep).toContain("bun publish --access public");
    expect(publishStep).toContain("NPM_CONFIG_TOKEN: ${{ secrets.NPM_TOKEN }}");
    expect(publishStep).toContain("NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}");
  });
});
