import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { hasAndroidToolchain } from "../../../src/services/device-hub/android-sdk";

it("finds the emulator toolchain in a configured SDK or through adb on PATH", async () => {
  const home = await mkdtemp(join(tmpdir(), "deus-android-tools-"));
  try {
    const sdk = join(home, "custom-sdk");
    for (const tool of ["platform-tools/adb", "emulator/emulator"]) {
      const file = join(sdk, tool);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, "", { mode: 0o755 });
    }
    const env = { ANDROID_HOME: sdk, PATH: "" };
    expect(await hasAndroidToolchain(env, home)).toBe(false);
    const avd = join(sdk, "cmdline-tools/latest/bin", "avdmanager");
    await mkdir(dirname(avd), { recursive: true });
    await writeFile(avd, "", { mode: 0o755 });
    expect(await hasAndroidToolchain(env, home)).toBe(true);
    await symlink(join(sdk, "platform-tools", "adb"), join(home, "adb"));
    expect(await hasAndroidToolchain({ PATH: home }, home)).toBe(true);
    await chmod(avd, 0o600);
    expect(await hasAndroidToolchain(env, home)).toBe(false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
