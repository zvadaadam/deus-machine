import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { assertPackagedRuntimePlatform } = require(
  "../../../scripts/runtime/electron-builder-before-pack.cjs"
) as {
  assertPackagedRuntimePlatform: (context?: { electronPlatformName?: string }) => void;
};

describe("electron-builder beforePack runtime guard", () => {
  it("allows macOS packaging where native runtime binaries are staged", () => {
    expect(() => assertPackagedRuntimePlatform({ electronPlatformName: "darwin" })).not.toThrow();
  });

  it("rejects non-macOS packaging until native runtime binaries are staged", () => {
    expect(() => assertPackagedRuntimePlatform({ electronPlatformName: "linux" })).toThrow(
      /native runtime is currently staged only for macOS/
    );
  });
});
