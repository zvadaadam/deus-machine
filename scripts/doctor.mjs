// Checks that this machine can develop, package, and deploy Deus.
// Run: bun run doctor
//
// "required" failures break `bun install` / `bun run dev`. "optional" ones
// only disable a feature (iOS simulator, local packaging, manual deploys).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
const wantNodeMajor = readFileSync(join(rootDir, ".node-version"), "utf8").trim().split(".")[0];
const wantBun = String(pkg.packageManager ?? "").replace(/^bun@/, "");

function out(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

const results = [];
function check(level, name, ok, detail, fix) {
  results.push({ level, name, ok, detail, fix });
}

// ── Required ────────────────────────────────────────────────────────────
const nodeVersion = out("node", ["--version"]);
const nodeMajor = nodeVersion?.replace(/^v/, "").split(".")[0];
check(
  "required",
  `Node ${wantNodeMajor}.x`,
  nodeMajor === wantNodeMajor,
  nodeVersion ?? "not found",
  `better-sqlite3 and node-pty are compiled against Node ${wantNodeMajor}. ` +
    `Install it (brew install node@${wantNodeMajor} && brew link --overwrite --force node@${wantNodeMajor}) ` +
    "or use a version manager that reads .node-version (fnm, mise)."
);

const bunVersion = out("bun", ["--version"]);
check(
  "required",
  "Bun",
  Boolean(bunVersion),
  bunVersion ?? "not found",
  "curl -fsSL https://bun.sh/install | bash"
);
if (bunVersion && wantBun && bunVersion !== wantBun) {
  check(
    "optional",
    `Bun matches CI pin (${wantBun})`,
    false,
    bunVersion,
    `CI installs with bun@${wantBun}. If this Bun rewrites bun.lock, CI's --frozen-lockfile can fail; ` +
      "do not commit lockfile changes you did not intend."
  );
}

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

check(
  "required",
  "git",
  Boolean(out("git", ["--version"])),
  out("git", ["--version"]) ?? "not found",
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

// Electron's postinstall downloads the binary and writes path.txt last. An
// install interrupted mid-download leaves a partial dist/ that Bun treats as
// done, and `bun run dev` then fails with "Electron uninstall". Optional:
// web-only and cloud setups (`bun run dev:web`) never need the binary.
check(
  "optional",
  "Electron binary downloaded (bun run dev)",
  existsSync(join(rootDir, "node_modules", "electron", "path.txt")),
  existsSync(join(rootDir, "node_modules", "electron", "path.txt"))
    ? "present"
    : "missing (interrupted install)",
  "node node_modules/electron/install.js"
);

// ── Optional ────────────────────────────────────────────────────────────
if (process.platform === "darwin") {
  const developerDir = out("xcode-select", ["-p"]) ?? "";
  const fullXcode = developerDir.includes(".app/") && Boolean(out("xcodebuild", ["-version"]));
  check(
    "optional",
    "Full Xcode (iOS simulator, local macOS packaging)",
    fullXcode,
    developerDir || "not found",
    "Install Xcode from the App Store, then: sudo xcode-select -s /Applications/Xcode.app && sudo xcodebuild -license accept. " +
      "Without it the simulator helpers are not built and `bun run build:all` / `package:mac` fail."
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
  check(
    "optional",
    `apps/${app} dependencies (typecheck:all, deploys)`,
    existsSync(join(rootDir, "apps", app, "node_modules")),
    existsSync(join(rootDir, "apps", app, "node_modules")) ? "installed" : "not installed",
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
