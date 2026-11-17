#!/usr/bin/env node
/**
 * Builds and packs the `deus-machine` CLI as the release publishes it, installs
 * the tarball into an empty directory with npm (as a person installs it) and
 * requires `deus --version` to print the package's version, then `deus start`
 * to bring its backend up (port printed, `/api/health` answering) and to stop.
 *
 * Run after `bun run build:runtime`, as the release does:
 *
 *   bun run smoke:cli-package [-- --tarball <path>]
 *
 * `--tarball` keeps the packed file at that path: the release publishes the
 * tarball this script tried, not a second pack.
 */
const { execFileSync, spawn } = require("node:child_process");
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "../../..");
const cliDir = path.join(projectRoot, "apps", "cli");

function parseArgs(argv) {
  const options = { tarball: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--tarball" && argv[index + 1]) {
      options.tarball = path.resolve(argv[index + 1]);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argv[index]}`);
    }
  }
  return options;
}

function run(command, args, cwd) {
  console.log(`$ ${[command, ...args].join(" ")}  (in ${cwd})`);
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const backendBundle = path.join(projectRoot, "apps", "backend", "dist", "server.bundled.cjs");
  if (!existsSync(backendBundle)) {
    throw new Error(`Missing ${backendBundle}: run \`bun run build:runtime\` first.`);
  }
  const { version } = JSON.parse(readFileSync(path.join(cliDir, "package.json"), "utf8"));

  const work = mkdtempSync(path.join(os.tmpdir(), "deus-cli-smoke-"));
  try {
    const tarball = options.tarball ?? path.join(work, "deus-machine.tgz");

    // The release's build and pack, in apps/cli.
    run("bun", ["run", "build"], cliDir);
    run("bun", ["pm", "pack", "--filename", tarball], cliDir);

    // A fresh directory, outside the repository, installed from the tarball alone.
    const installDir = path.join(work, "install");
    mkdirSync(installDir);
    writeFileSync(
      path.join(installDir, "package.json"),
      JSON.stringify({ name: "deus-cli-smoke", private: true }) + "\n"
    );
    run(
      "npm",
      ["install", "--no-audit", "--no-fund", "--no-package-lock", "--loglevel=error", tarball],
      installDir
    );

    const deus = path.join(installDir, "node_modules", ".bin", "deus");
    const printed = execFileSync(deus, ["--version"], {
      cwd: installDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
      timeout: 30_000,
    }).trim();
    console.log(`$ deus --version\n${printed}`);
    if (printed !== version) {
      throw new Error(`deus --version printed "${printed}", expected "${version}"`);
    }
    console.log(`✓ The packed CLI installs and prints its version (${version})`);

    await startAndStop(deus, work);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * `deus start` from the install, in a home of its own: the first-run wizard
 * answered as "skipped, no remote access" (it asks on a terminal otherwise),
 * the database in a temporary `--data-dir`, no Keychain, skills and Codex
 * homes inside the temporary home. No account, sign-in or relay is involved.
 * Up means the backend printed its port and `GET /api/health` on it answers;
 * then the CLI is stopped by pid and must exit, taking the backend with it.
 */
async function startAndStop(deus, work) {
  const home = path.join(work, "home");
  // apps/cli/src/config.ts: ~/.config/deus on macOS, $XDG_CONFIG_HOME/deus elsewhere.
  const configDir = path.join(home, ".config", "deus");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({ onboarding_completed: true, auth_method: "skipped", relay_enabled: false })
  );
  const dataDir = path.join(work, "data");

  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("DEUS_") || key === "AUTH_TOKEN" || key === "DATABASE_PATH") delete env[key];
  }
  Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    CODEX_HOME: path.join(home, ".codex"),
    DEUS_SKILLS_HOME: home,
    DEUS_VAULT_NO_KEYCHAIN: "1",
  });

  console.log(`$ deus start --data-dir ${dataDir}  (HOME=${home})`);
  const child = spawn(deus, ["start", "--data-dir", dataDir], {
    cwd: work,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  let output = "";
  const exited = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal }))
  );
  child.stdout.on("data", (data) => (output += data.toString()));
  child.stderr.on("data", (data) => (output += data.toString()));

  const killGroup = () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  };

  try {
    const port = await waitFor(60_000, () => {
      if (child.exitCode !== null) throw new Error(`deus start exited (${child.exitCode})`);
      const match = output.match(/^\[BACKEND_PORT\](\d+)$/m);
      return match ? Number(match[1]) : null;
    });
    console.log(`[BACKEND_PORT]${port}`);
    const health = await waitFor(15_000, () => healthy(port));
    console.log(`GET http://127.0.0.1:${port}/api/health → ${health}`);

    process.kill(child.pid, "SIGTERM");
    const result = await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(() => resolve(null), 15_000)),
    ]);
    if (!result) throw new Error("deus start did not exit within 15s of SIGTERM");
    if ((await healthy(port)) !== null) {
      throw new Error(`the backend still answers on port ${port} after deus start exited`);
    }
    console.log(`✓ deus start brought the backend up and stopped it (exit ${result.code})`);
  } catch (error) {
    killGroup();
    throw new Error(
      `${error instanceof Error ? error.message : error}\n--- deus start output ---\n${output}`
    );
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
  console.error(`✗ CLI package smoke failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
