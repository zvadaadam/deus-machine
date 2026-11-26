import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";

/** Find one SDK with all the tools the hub uses to list, start and stream emulators. */
export async function findAndroidSdk(env = process.env, home = homedir()) {
  const roots = new Set(
    [env.ANDROID_HOME, env.ANDROID_SDK_ROOT].filter((root): root is string => !!root)
  );
  if (process.platform === "darwin") roots.add(join(home, "Library/Android/sdk"));
  else {
    roots.add(join(home, "Android/Sdk"));
    roots.add(join(home, "Android/sdk"));
  }
  // A CLI on PATH can be a symlink into an SDK outside the default locations.
  const pathRoots = await Promise.all(
    (env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .flatMap((directory) =>
        ["adb", "emulator"].map(async (tool) => {
          const file = await realpath(join(directory, tool)).catch(() => null);
          if (!file) return null;
          const parent = dirname(file);
          return basename(parent) === (tool === "adb" ? "platform-tools" : "emulator")
            ? dirname(parent)
            : null;
        })
      )
  );
  for (const root of pathRoots) if (root) roots.add(root);
  const tools = ["platform-tools/adb", "emulator/emulator", "cmdline-tools/latest/bin/avdmanager"];
  for (const root of roots) {
    try {
      await Promise.all(tools.map((tool) => access(join(root, tool), constants.X_OK)));
      return resolve(root);
    } catch {
      // Try the next SDK if this one is incomplete.
    }
  }
  return null;
}
