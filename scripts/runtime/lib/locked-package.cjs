const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A package bun.lock pins: its name, version, integrity and npm tarball. */
function readLockedPackage(projectRoot, lockKey) {
  const lockPath = path.join(projectRoot, "bun.lock");
  const entryPattern = new RegExp(
    `^\\s+"${escapeRegExp(lockKey)}": \\["([^"]+)".*"((?:sha\\d+-)[^"]+)"\\],?$`,
    "m"
  );
  const match = fs.readFileSync(lockPath, "utf8").match(entryPattern);
  if (!match) throw new Error(`Missing ${lockKey} in ${lockPath}`);
  const separator = match[1].lastIndexOf("@");
  if (separator <= 0) throw new Error(`Unexpected package spec in bun.lock: ${match[1]}`);
  const packageName = match[1].slice(0, separator);
  const version = match[1].slice(separator + 1);
  return {
    lockKey,
    packageName,
    version,
    integrity: match[2],
    url: `https://registry.npmjs.org/${packageName}/-/${packageName.split("/").pop()}-${version}.tgz`,
  };
}

/** Throws unless the downloaded tarball is the one bun.lock pins. */
function verifyIntegrity(buffer, lockedPackage) {
  const [algorithm, expected] = lockedPackage.integrity.split("-");
  const actual = crypto.createHash(algorithm).update(buffer).digest("base64");
  if (actual !== expected) {
    throw new Error(
      `Integrity mismatch for ${lockedPackage.url}: expected ${lockedPackage.integrity}`
    );
  }
}

module.exports = { readLockedPackage, verifyIntegrity };
