import { chmod, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { findAndroidSdk } from "../../../src/services/device-hub/android-sdk";

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
    const otherSdk = join(home, "partial-sdk");
    const avdPath = "cmdline-tools/latest/bin/avdmanager";
    const otherAvd = join(otherSdk, avdPath);
    await mkdir(dirname(otherAvd), { recursive: true });
    await writeFile(otherAvd, "", { mode: 0o755 });
    expect(await findAndroidSdk({ ...env, ANDROID_SDK_ROOT: otherSdk }, home)).toBeNull();
    const avd = join(sdk, avdPath);
    await mkdir(dirname(avd), { recursive: true });
    await rename(otherAvd, avd);
    expect(await findAndroidSdk(env, home)).toBe(sdk);
    await symlink(join(sdk, "platform-tools", "adb"), join(home, "adb"));
    expect(await findAndroidSdk({ PATH: home }, home)).toBe(await realpath(sdk));
    await chmod(avd, 0o600);
    expect(await findAndroidSdk(env, home)).toBeNull();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
