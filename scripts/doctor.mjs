// Checks that this machine can develop, package, and deploy Deus.
// Run: bun run doctor
//
// "required" checks cover installs, development and the pre-push gate. "optional" ones
// only disable a feature (iOS simulator, local packaging, manual deploys).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
const wantNodeMajor = readFileSync(join(rootDir, ".node-version"), "utf8").trim().split(".")[0];
const wantBun = String(pkg.packageManager ?? "").replace(/^bun@/, "");

function out(cmd, args, env = process.env) {
  try {
    const options = { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env };
    return execFileSync(cmd, args, options).trim();
  } catch {
    return null;
  }
}

const results = [];
function check(level, name, ok, detail, fix) {
  results.push({ level, name, ok, detail, fix });
}

// ── Required ────────────────────────────────────────────────────────────
// The native modules are Node-API prebuilds, so any Node from the pinned
// major on loads them; CI runs the pinned one.
const nodeVersion = out("node", ["--version"]);
const nodeMajor = Number(nodeVersion?.replace(/^v/, "").split(".")[0]);
check(
  "required",
  `Node ${wantNodeMajor} or newer`,
  nodeMajor >= Number(wantNodeMajor),
  nodeVersion
    ? `${nodeVersion}${nodeMajor > Number(wantNodeMajor) ? ` (CI runs ${wantNodeMajor})` : ""}`
    : "not found",
  `Install Node ${wantNodeMajor} or newer (brew install node, or a version manager that reads .node-version such as fnm/mise).`
);

const bunVersion = out("bun", ["--version"]);
check(
  "required",
  `Bun ${wantBun} (CI and runtime builds)`,
  bunVersion === wantBun,
  bunVersion ?? "not found",
  `curl -fsSL https://bun.sh/install | bash -s bun-v${wantBun}`
);

// On macOS, ask xcode-select first: calling the /usr/bin/clang shim without
// the Command Line Tools opens the "install developer tools" dialog.
const toolchain =
  process.platform === "darwin"
    ? out("xcode-select", ["-p"])
    : (out("gcc", ["--version"]) ?? out("clang", ["--version"]))?.split("\n")[0];
check(
  "required",
  "C/C++ toolchain",
  Boolean(toolchain),
  toolchain ?? "not found",
  process.platform === "darwin" ? "xcode-select --install" : "Install gcc/g++ and make."
);

const gitVersion = out("git", ["--version"]);
const [gitMajor, gitMinor] = gitVersion?.split(" ")[2]?.split(".").map(Number) ?? [];
check(
  "required",
  "Git 2.30+",
  gitMajor > 2 || (gitMajor === 2 && gitMinor >= 30),
  gitVersion ?? "not found",
  "brew install git"
);

check(
  "required",
  "Dependencies installed",
  existsSync(join(rootDir, "node_modules", "electron")) &&
    existsSync(join(rootDir, "node_modules", "better-sqlite3")),
  existsSync(join(rootDir, "node_modules", "electron"))
    ? "node_modules present"
    : "node_modules incomplete",
  "bun run setup"
);

const browser = await import("playwright")
  .then(({ chromium }) => chromium.launch())
  .catch(() => null);
check(
  "required",
  "Headless Chromium (bun run check)",
  Boolean(browser),
  browser?.version() ?? "unavailable",
  "bunx playwright install --with-deps chromium"
);
await browser?.close();

for (const command of ["ffmpeg", "ffprobe"]) {
  const version = out(command, ["-version"])?.split("\n")[0];
  check(
    "required",
    `${command} (bun run check)`,
    Boolean(version),
    version ?? "missing",
    process.platform === "darwin" ? "brew install ffmpeg" : "Install FFmpeg and ffprobe."
  );
}

// Electron (42 and later) has no postinstall: `bun run dev` and
// `bun run package:mac:dir` download the binary (`bun run electron:install`,
// Electron's install.js), which writes path.txt last. A download cut
// short leaves no path.txt, and electron-vite then fails with "Electron
// uninstall". Optional: web-only and cloud setups (`bun run dev:web`) never
// need the binary.
check(
  "optional",
  "Electron binary downloaded (bun run dev)",
  existsSync(join(rootDir, "node_modules", "electron", "path.txt")),
  existsSync(join(rootDir, "node_modules", "electron", "path.txt"))
    ? "present"
    : "not downloaded yet (bun run dev downloads it)",
  "bun run electron:install"
);

// ── Optional ────────────────────────────────────────────────────────────
if (process.platform === "darwin") {
  const env = (await import("../apps/backend/src/services/device-hub/xcode-env.ts")).simulatorEnv();
  const developerDir = out("xcode-select", ["-p"], env) ?? "";
  const fullXcode = developerDir.includes(".app/") && Boolean(out("xcodebuild", ["-version"], env));
  check(
    "optional",
    "Full Xcode (iOS Simulators)",
    fullXcode,
    developerDir || "not found",
    "Install Xcode in /Applications or set DEVELOPER_DIR to its Contents/Developer directory."
  );

  const identities = out("security", ["find-identity", "-v", "-p", "codesigning"]) ?? "";
  check(
    "optional",
    "Developer ID signing identity (local signed builds)",
    identities.includes("Developer ID Application"),
    identities.includes("Developer ID Application") ? "found" : "none in keychain",
    "Only needed to sign locally; releases are signed in CI (.github/workflows/release.yml)."
  );
}

check(
  "optional",
  "jq (scripts/bump-version.sh)",
  Boolean(out("jq", ["--version"])),
  out("jq", ["--version"]) ?? "not found",
  "brew install jq"
);

check(
  "optional",
  "GitHub CLI authenticated (releases, PRs)",
  out("gh", ["auth", "status"]) !== null,
  out("gh", ["--version"])?.split("\n")[0] ?? "gh not found",
  "brew install gh && gh auth login"
);

for (const app of ["cloud-relay", "landing"]) {
  const relay = app === "cloud-relay";
  const installed = existsSync(join(rootDir, "apps", app, "node_modules"));
  check(
    relay ? "required" : "optional",
    `apps/${app} dependencies (${relay ? "bun run check" : "landing deploy"})`,
    installed,
    installed ? "installed" : "not installed",
    "bun run setup"
  );
}

check(
  "optional",
  "Agent CLI or API key (Claude or Codex)",
  Boolean(out("claude", ["--version"]) ?? out("codex", ["--version"])) ||
    Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY),
  [out("claude", ["--version"]), out("codex", ["--version"])].filter(Boolean).join(", ") ||
    "no CLI or API key found",
  "Install and sign in to `claude` / `codex`, or set ANTHROPIC_API_KEY / OPENAI_API_KEY (see .env.example). " +
    "This checks the CLI is installed, not that it is signed in."
);

// ── Report ──────────────────────────────────────────────────────────────
let requiredFailed = 0;
for (const level of ["required", "optional"]) {
  console.log(`\n${level === "required" ? "Required" : "Optional"}`);
  for (const r of results.filter((x) => x.level === level)) {
    const mark = r.ok ? "✓" : level === "required" ? "✗" : "!";
    console.log(`  ${mark} ${r.name} — ${r.detail}`);
    if (!r.ok) {
      console.log(`      ${r.fix}`);
      if (level === "required") requiredFailed++;
    }
  }
}

console.log(
  requiredFailed
    ? `\n${requiredFailed} required check(s) failed.`
    : "\nReady to develop. Start with `bun run dev:web` or `bun run dev`."
);
process.exit(requiredFailed ? 1 : 0);
