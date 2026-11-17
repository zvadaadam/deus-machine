const path = require("node:path");
const { spawnSync } = require("node:child_process");

// What only the signature decides, read once the app is signed: deus-runtime
// keeps what Bun needs under the hardened runtime, and its 4 KB pages.
const SIGNED_RUNTIME_FACTS = [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.disable-library-validation",
  "Page size=4096",
];

module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const runtime = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    "Contents/Resources/bin/deus-runtime"
  );
  const result = spawnSync("codesign", ["-d", "--verbose=4", "--entitlements", ":-", runtime], {
    encoding: "utf8",
  });
  const signature = `${result.stdout}\n${result.stderr}`;
  if (result.status !== 0) throw new Error(`Cannot read the signature of ${runtime}: ${signature}`);
  for (const fact of SIGNED_RUNTIME_FACTS) {
    if (!signature.includes(fact)) throw new Error(`Signed ${runtime} lacks ${fact}`);
  }
  console.log("[runtime] signed deus-runtime entitlements and page size verified");
};
