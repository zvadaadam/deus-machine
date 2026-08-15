#!/usr/bin/env bun
/**
 * Revendor the `@zvada/agent-server` tarball and make bun ACTUALLY use it.
 *
 * Replacing the file in vendor/ is not enough: bun caches `file:` tarballs by
 * PATH (`~/.bun/install/cache/@T@*`), reuses the stale extraction silently,
 * and refuses a tarball whose hash no longer matches `bun.lock`. This script
 * does the whole dance — copy, lockfile integrity, cache purge, reinstall —
 * and then PROVES the installed source matches the tarball byte-for-byte.
 *
 *   bun scripts/vendor-engine.ts [path-to-freshly-packed.tgz]
 *
 * With no argument it re-syncs from the tarball already in vendor/ (after a
 * `git pull` that changed it, say). Temporary tooling: dies with vendor/ when
 * the engine publishes to npm and the pins flip to semver.
 */
import { $ } from "bun";
import { createHash } from "node:crypto";
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const VENDORED = "vendor/zvada-agent-server-0.3.0.tgz";

const source = process.argv[2];
if (source) {
  cpSync(source, VENDORED);
  console.log(`copied ${source} -> ${VENDORED}`);
}
if (!existsSync(VENDORED)) throw new Error(`${VENDORED} not found`);

// -- 1. bun.lock integrity ---------------------------------------------------
const sha512 = `sha512-${createHash("sha512").update(readFileSync(VENDORED)).digest("base64")}`;
const lock = readFileSync("bun.lock", "utf8");
const entry = lock.match(/"@zvada\/agent-server@[^"]*\.tgz"[\s\S]*?"(sha512-[A-Za-z0-9+/=]+)"\]/);
if (!entry) throw new Error("no @zvada/agent-server tarball entry found in bun.lock");
const previous = entry[1] as string;
if (previous === sha512) {
  console.log("bun.lock integrity already current");
} else {
  if (lock.split(previous).length !== 2) {
    throw new Error("integrity hash is not unique in bun.lock — refusing a blind replace");
  }
  writeFileSync("bun.lock", lock.replace(previous, sha512));
  console.log(`bun.lock integrity ${previous.slice(0, 18)}… -> ${sha512.slice(0, 18)}…`);
}

// -- 2. purge every place bun may have kept the OLD extraction ---------------
const cache = join(homedir(), ".bun", "install", "cache");
rmSync(join(cache, "@zvada"), { recursive: true, force: true });
for (const dir of readdirSync(cache).filter((name) => name.startsWith("@T@"))) {
  try {
    const pkg = JSON.parse(readFileSync(join(cache, dir, "package.json"), "utf8")) as {
      name?: string;
    };
    if (pkg.name === "@zvada/agent-server")
      rmSync(join(cache, dir), { recursive: true, force: true });
  } catch {
    // not a package dir — leave it
  }
}
await $`bash -c 'rm -rf node_modules/.bun/@zvada+agent-server@* node_modules/@zvada apps/*/node_modules/@zvada packages/*/node_modules/@zvada'`.nothrow();

// -- 3. reinstall and PROVE freshness ---------------------------------------
await $`bun install`;

const probeFile = "package/src/protocol/reduce.ts";
const fromTarball = await $`tar -xzOf ${VENDORED} ${probeFile}`.text();
const candidates = [
  "node_modules/@zvada/agent-server/src/protocol/reduce.ts",
  ...(existsSync("node_modules/.bun") ? readdirSync("node_modules/.bun", { recursive: false }) : [])
    .filter((name) => String(name).startsWith("@zvada+agent-server@"))
    .map((name) =>
      join(
        "node_modules/.bun",
        String(name),
        "node_modules/@zvada/agent-server/src/protocol/reduce.ts"
      )
    ),
].filter((path) => existsSync(path));
if (candidates.length === 0) throw new Error("no installed copy of @zvada/agent-server found");
for (const path of candidates) {
  if (readFileSync(path, "utf8") !== fromTarball) {
    throw new Error(`STALE install at ${path} — bun reused an old extraction`);
  }
}
console.log(
  `fresh: ${candidates.length} installed cop${candidates.length === 1 ? "y" : "ies"} match the tarball`
);
