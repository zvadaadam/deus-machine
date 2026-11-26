import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { launch } from "./process";
import { hubManifest, hubVersion } from "./support";

const packagePath = "node_modules/expo-device-hub";
export const cliPath = packagePath + "/dist/server/cli.mjs";

function hasCode(error: unknown, ...codes: string[]) {
  return error instanceof Error && "code" in error && codes.includes(String(error.code));
}

export async function installPath(base: string) {
  const lock = await readFile(join(hubManifest(), "bun.lock"));
  const hash = createHash("sha256").update(lock).digest("hex").slice(0, 8);
  return join(base, hubVersion + "-" + hash);
}

export async function validInstall(directory: string) {
  try {
    const pkg = JSON.parse(await readFile(join(directory, packagePath, "package.json"), "utf8"));
    return pkg?.version === hubVersion && (await stat(join(directory, cliPath))).isFile();
  } catch (error) {
    if (error instanceof SyntaxError || hasCode(error, "ENOENT", "ENOTDIR", "EISDIR")) return false;
    throw error;
  }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (hasCode(error, "ESRCH")) return false;
    if (hasCode(error, "EPERM")) return true;
    throw error;
  }
}

export async function withOwnedDirectory(
  parent: string,
  prefix: string,
  use: (directory: string) => Promise<void>
) {
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(parent, prefix + process.pid + "-"));
    await writeFile(join(directory, "owner.pid"), String(process.pid), { mode: 0o600 });
    await use(directory);
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

async function pidFile(path: string) {
  const value = await readFile(path, "utf8").catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) return "";
    throw error;
  });
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

async function removeAbandoned(parent: string, prefix: string) {
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const dir = join(parent, entry.name);
    // The name records the creator even if it died between mkdir and writing owner.pid.
    const owner =
      (await pidFile(join(dir, "owner.pid"))) ??
      Number(/^(\d+)-/.exec(entry.name.slice(prefix.length))?.[1]);
    if (!(owner > 0) || alive(owner)) continue;
    const group = await pidFile(join(dir, "group.pid"));
    if (!group || !alive(-group)) await rm(dir, { recursive: true, force: true });
  }
}

export async function prepareDirectories(base: string) {
  const run = join(base, "run");
  await mkdir(base, { recursive: true, mode: 0o700 });
  await chmod(base, 0o700);
  await mkdir(run, { recursive: true, mode: 0o700 });
  await Promise.all([
    removeAbandoned(base, ".install-"),
    removeAbandoned(run, ""),
    reclaimLock(join(base, "install.lock")),
  ]);
  return run;
}

async function releaseLock(lock: string, ownerFile: string) {
  // Unlink only this owner's marker. A concurrent claimant publishes a nonempty directory.
  await unlink(join(lock, ownerFile)).catch((error: unknown) => {
    if (!hasCode(error, "ENOENT")) throw error;
  });
  await rmdir(lock).catch((error: unknown) => {
    if (!hasCode(error, "ENOENT", "ENOTEMPTY", "EEXIST")) throw error;
  });
}

async function reclaimLock(lock: string) {
  const owners = await readdir(lock).catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  });
  for (const file of owners) {
    const pid = Number(/^owner-(\d+)$/.exec(file)?.[1]);
    if (pid > 0 && !alive(pid)) await releaseLock(lock, file);
  }
}

async function takeLock(lock: string, staging: string, signal: AbortSignal) {
  const claim = join(staging, "lock");
  const marker = "owner-" + process.pid;
  await mkdir(claim, { mode: 0o700 });
  await writeFile(join(claim, marker), String(process.pid), { mode: 0o600 });
  for (;;) {
    signal.throwIfAborted();
    try {
      // Publish the mkdir lock and its owner together. A nonempty lock cannot be replaced.
      await rename(claim, lock);
      return () => releaseLock(lock, marker);
    } catch (error) {
      if (!hasCode(error, "ENOTEMPTY", "EEXIST")) throw error;
    }
    await reclaimLock(lock);
    await delay(100, undefined, { signal });
  }
}

export async function installHub(
  base: string,
  installed: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal
) {
  await withOwnedDirectory(base, ".install-", async (staging) => {
    const unlock = await takeLock(join(base, "install.lock"), staging, signal);
    try {
      if (await validInstall(installed)) return;
      for (const file of ["package.json", "bun.lock"])
        await cp(join(hubManifest(), file), join(staging, file));
      await launch(
        ["install", "--frozen-lockfile", "--ignore-scripts"],
        staging,
        env,
        AbortSignal.any([signal, AbortSignal.timeout(180_000)]),
        { directory: staging, installing: true }
      ).closed;
      if (!(await validInstall(staging)))
        throw new Error("Bun did not install the pinned device package.");
      signal.throwIfAborted();
      if (
        await lstat(installed).catch((error: unknown) => {
          if (hasCode(error, "ENOENT")) return null;
          throw error;
        })
      ) {
        if (await validInstall(installed)) return;
        await rm(installed, { recursive: true });
      }
      await unlink(join(staging, "owner.pid"));
      await rm(join(staging, "group.pid"), { force: true });
      try {
        await rename(staging, installed);
      } catch (error) {
        if (!hasCode(error, "EEXIST", "ENOTEMPTY") || !(await validInstall(installed))) throw error;
      }
    } finally {
      await unlock();
    }
  });
}
