import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";

/** The SDK executables used by the hub to list and start emulators. */
export async function hasAndroidToolchain(env = process.env, home = homedir()) {
  const windows = process.platform === "win32";
  const adb = windows ? "adb.exe" : "adb";
  const emulator = windows ? "emulator.exe" : "emulator";
  const avdmanager = windows ? "avdmanager.bat" : "avdmanager";
  const roots = new Set(
    [env.ANDROID_HOME, env.ANDROID_SDK_ROOT].filter((root): root is string => !!root)
  );
  if (process.platform === "darwin") roots.add(join(home, "Library/Android/sdk"));
  else if (windows) roots.add(join(env.LOCALAPPDATA || join(home, "AppData/Local"), "Android/Sdk"));
  else {
    roots.add(join(home, "Android/Sdk"));
    roots.add(join(home, "Android/sdk"));
  }
  // A CLI on PATH can be a symlink into an SDK outside the default locations.
  await Promise.all(
    (env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .flatMap((directory) =>
        [adb, emulator].map(async (tool) => {
          const file = await realpath(join(directory, tool)).catch(() => null);
          if (!file) return;
          const parent = dirname(file);
          if (basename(parent) === (tool === adb ? "platform-tools" : "emulator"))
            roots.add(dirname(parent));
        })
      )
  );
  const tools = [
    join("platform-tools", adb),
    join("emulator", emulator),
    join("cmdline-tools/latest/bin", avdmanager),
  ];
  const found = await Promise.all(
    tools.map((tool) =>
      Promise.any([...roots].map((root) => access(join(root, tool), constants.X_OK))).then(
        () => true,
        () => false
      )
    )
  );
  return found.every(Boolean);
}
