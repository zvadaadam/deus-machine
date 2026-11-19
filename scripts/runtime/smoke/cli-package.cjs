#!/usr/bin/env node
/**
 * Builds and packs the `deus-machine` CLI as the release publishes it, installs
 * the tarball into an empty directory with npm (as a person installs it), and
 * requires `deus --version` to print the package's version and `deus start` to
 * bring its backend up (`/api/health` answering) and to stop.
 *
 * Run after `bun run build:runtime`, as the release does:
 *
 *   bun run smoke:cli-package [-- --tarball <path>]
 *
 * `--tarball` keeps the packed file at that path, so the release publishes the
 * tarball this script tried.
 */
const { execFileSync, spawn } = require("node:child_process");
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const cliDir = path.resolve(__dirname, "../../../apps/cli");

function run(command, args, cwd) {
  console.log(`$ ${[command, ...args].join(" ")}  (in ${cwd})`);
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

async function main() {
  const tarballArg = process.argv.indexOf("--tarball");
  const { version } = JSON.parse(readFileSync(path.join(cliDir, "package.json"), "utf8"));
  const work = mkdtempSync(path.join(os.tmpdir(), "deus-cli-smoke-"));
  try {
    const tarball =
      tarballArg === -1
        ? path.join(work, "deus-machine.tgz")
        : path.resolve(process.argv[tarballArg + 1]);
    run("bun", ["run", "build"], cliDir);
    run("bun", ["pm", "pack", "--filename", tarball], cliDir);

    const installDir = path.join(work, "install");
    mkdirSync(installDir);
    writeFileSync(path.join(installDir, "package.json"), '{"name":"smoke","private":true}\n');
    run(
      "npm",
      ["install", "--no-audit", "--no-fund", "--no-package-lock", "--loglevel=error", tarball],
      installDir
    );

    const deus = path.join(installDir, "node_modules", ".bin", "deus");
    const printed = execFileSync(deus, ["--version"], { encoding: "utf8", timeout: 30_000 }).trim();
    console.log(`$ deus --version\n${printed}`);
    if (printed !== version) throw new Error(`deus --version printed "${printed}", not ${version}`);

    await startAndStop(deus, work);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * `deus start` in a home of its own: the first-run wizard (which asks on a
 * terminal) answered as "skipped, no remote access", a temporary database, no
 * Keychain. No account, sign-in or relay is involved.
 */
async function startAndStop(deus, work) {
  const home = path.join(work, "home");
  // apps/cli/src/config.ts: ~/.config/deus on macOS, $XDG_CONFIG_HOME/deus elsewhere.
  mkdirSync(path.join(home, ".config", "deus"), { recursive: true });
  writeFileSync(
    path.join(home, ".config", "deus", "config.json"),
    JSON.stringify({ onboarding_completed: true, auth_method: "skipped", relay_enabled: false })
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("DEUS_") && key !== "DATABASE_PATH"
    )
  );
  Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    CODEX_HOME: path.join(home, ".codex"),
    DEUS_SKILLS_HOME: home,
    DEUS_VAULT_NO_KEYCHAIN: "1",
  });

  const dataDir = path.join(work, "data");
  console.log(`$ deus start --data-dir ${dataDir}  (HOME=${home})`);
  const child = spawn(deus, ["start", "--data-dir", dataDir], {
    cwd: work,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let output = "";
  child.stdout.on("data", (data) => (output += data));
  child.stderr.on("data", (data) => (output += data));

  try {
    const port = await waitFor(60_000, () => {
      if (child.exitCode !== null) throw new Error(`deus start exited (${child.exitCode})`);
      return output.match(/^\[BACKEND_PORT\](\d+)$/m)?.[1];
    });
    const health = await waitFor(15_000, () => healthy(port));
    console.log(`[BACKEND_PORT]${port}\nGET /api/health → ${health}`);

    process.kill(child.pid, "SIGTERM");
    const code = await waitFor(15_000, () => child.exitCode);
    if (code !== 0) throw new Error(`deus start exited with code ${code} after SIGTERM`);
    if (await healthy(port)) throw new Error(`the backend still answers on port ${port}`);
    console.log(`✓ deus start brought the backend up and stopped it (exit ${code})`);
  } catch (error) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
    throw new Error(`${error.message}\n--- deus start output ---\n${output}`);
  }
}

async function healthy(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok ? `${response.status} ${await response.text()}` : null;
  } catch {
    return null;
  }
}

async function waitFor(timeoutMs, probe) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs / 1000}s`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

main().catch((error) => {
  console.error(`✗ CLI package smoke failed: ${error.message}`);
  process.exit(1);
});
