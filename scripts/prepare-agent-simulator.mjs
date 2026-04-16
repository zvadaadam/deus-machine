import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function log(message) {
  console.log(`[prepare-agent-simulator] ${message}`);
}

function tryResolvePackageDir() {
  const packageDir = join(process.cwd(), 'node_modules', 'agent-simulator');
  return existsSync(packageDir) ? packageDir : null;
}

function hasBuiltJs(packageDir) {
  return ['dist/sdk.js', 'dist/engine.js', 'dist/cli.js'].every((file) =>
    existsSync(join(packageDir, file))
  );
}

function run(command, args, cwd) {
  execFileSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: process.env,
  });
}

function findGlobalHelperPath() {
  const candidates = [
    '/opt/homebrew/lib/node_modules/agent-simulator/native/.build/release/sim-helper',
    '/usr/local/lib/node_modules/agent-simulator/native/.build/release/sim-helper',
    join(
      homedir(),
      '.bun/install/global/node_modules/agent-simulator/native/.build/release/sim-helper'
    ),
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function ensureLocalHelper(packageDir) {
  const nativeDir = join(packageDir, 'native');
  const buildDir = join(nativeDir, '.build');
  const releaseDir = join(buildDir, 'release');
  const releaseBinary = join(releaseDir, 'sim-helper');
  const archBinary = join(buildDir, 'arm64-apple-macosx', 'release', 'sim-helper');

  if (existsSync(releaseBinary)) {
    log('local sim-helper already present');
    return;
  }

  const globalHelper = findGlobalHelperPath();
  if (globalHelper) {
    mkdirSync(releaseDir, { recursive: true });
    copyFileSync(globalHelper, releaseBinary);
    log(`copied global sim-helper into local package from ${globalHelper}`);
    return;
  }

  try {
    execFileSync('swift', ['--version'], { stdio: 'pipe' });
  } catch {
    log('Swift not found; local sim-helper unavailable and no global helper found');
    return;
  }

  log('building local sim-helper binary in node_modules');
  try {
    run('swift', ['build', '-c', 'release'], nativeDir);
  } catch {
    log('native sim-helper build failed; global helper fallback may still work');
    return;
  }

  if (existsSync(releaseDir) && lstatSync(releaseDir).isSymbolicLink()) {
    unlinkSync(releaseDir);
  }

  mkdirSync(releaseDir, { recursive: true });

  if (existsSync(archBinary)) {
    copyFileSync(archBinary, releaseBinary);
    log(`copied arm64 sim-helper into ${releaseBinary}`);
  }
}

const packageDir = tryResolvePackageDir();
if (!packageDir) {
  log('agent-simulator not installed, skipping');
  process.exit(0);
}

if (!hasBuiltJs(packageDir)) {
  log('building linked agent-simulator JavaScript artifacts');
  try {
    run('bun', ['run', 'build'], packageDir);
  } catch (error) {
    if (!hasBuiltJs(packageDir)) {
      throw error;
    }
    log('build reported errors, but JavaScript artifacts exist; continuing');
  }
} else {
  log('JavaScript artifacts already present');
}

ensureLocalHelper(packageDir);
