import { describe, expect, it } from "vitest";
import { getAssetPattern } from "../../../apps/cli/src/desktop";

describe("desktop installer selection", () => {
  // Actual electron-builder release names; Intel DMGs have no suffix.
  const assets = [
    "Deus-0.3.10-arm64.dmg",
    "Deus-0.3.10.dmg",
    "Deus-0.3.10-arm64-mac.zip",
    "Deus-0.3.10-mac.zip",
    "Deus-0.3.10-arm64.dmg.blockmap",
    "Deus-0.3.10.AppImage",
    "deus_0.3.10_amd64.deb",
  ];

  it.each([
    ["darwin", "arm64", "Deus-0.3.10-arm64.dmg"],
    ["darwin", "x64", "Deus-0.3.10.dmg"],
    ["linux", "x64", "Deus-0.3.10.AppImage"],
  ])("selects exactly one installer for %s/%s", (os, arch, expected) => {
    expect(assets.filter(getAssetPattern(os, arch)!.matcher)).toEqual([expected]);
  });

  it("also accepts an explicitly named Intel DMG", () => {
    expect(getAssetPattern("darwin", "x64")!.matcher("Deus-0.3.10-x64.dmg")).toBe(true);
    expect(getAssetPattern("darwin", "arm64")!.matcher("Deus-0.3.10-x64.dmg")).toBe(false);
  });
});
