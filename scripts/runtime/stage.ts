import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRuntimeStagePaths } from "../../shared/runtime";

const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(runtimeDir, "../..");

export interface StageRuntimeOptions {
  log?: (line: string) => void;
  preserveElectron?: boolean;
}

/** Copies the backend bundle into dist/runtime, which the CLI ships. */
export function stageRuntime(options: StageRuntimeOptions = {}): void {
  const log = options.log ?? console.log;
  const stagePaths = resolveRuntimeStagePaths(projectRoot);
  const backendBundle = path.join(projectRoot, "apps", "backend", "dist", "server.bundled.cjs");
  if (!existsSync(backendBundle)) {
    throw new Error(`Missing backend bundle: ${backendBundle}`);
  }

  rmSync(options.preserveElectron === true ? stagePaths.common.root : stagePaths.root, {
    recursive: true,
    force: true,
  });
  mkdirSync(path.dirname(stagePaths.common.backendBundle), { recursive: true });
  cpSync(backendBundle, stagePaths.common.backendBundle);
  log(`✓ Runtime staged at ${path.relative(projectRoot, stagePaths.root)}`);
}
