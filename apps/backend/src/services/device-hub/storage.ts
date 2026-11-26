import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { launch, stopGroup } from "./process";
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

export async function withTempDirectory(prefix: string, use: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(prefix);
  try {
    await use(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function removeLeftovers(parent: string, prefix: string) {
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const directory = join(parent, entry.name);
    try {
      const group = Number(await readFile(join(directory, "group.pid"), "utf8"));
      if (Number.isSafeInteger(group) && group > 1) await stopGroup(group);
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

export async function prepareDirectories(base: string) {
  const run = join(base, "run");
  await mkdir(run, { recursive: true, mode: 0o700 });
  await chmod(base, 0o700);
  await Promise.all([removeLeftovers(base, ".install-"), removeLeftovers(run, "")]);
  return run;
}

export async function installHub(
  base: string,
  installed: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal
) {
  await withTempDirectory(join(base, ".install-"), async (staging) => {
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
    // The database owner only stages a replacement for a missing or incomplete install.
    await rm(installed, { recursive: true, force: true });
    await rename(staging, installed);
  });
}
