import { buildSync } from "esbuild";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEUS_APP_ID,
  DEUS_DB_FILENAME,
  DEUS_PREFERENCES_FILENAME,
  RUNTIME_MANIFEST_VERSION,
  resolveRuntimeStagePaths,
} from "../../shared/runtime";

const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
const defaultProjectRoot = path.resolve(runtimeDir, "../..");

export interface StageRuntimeOptions {
  log?: (line: string) => void;
  preserveElectron?: boolean;
  projectRoot?: string;
}

export interface RuntimeManifest {
  version: number;
  appId: string;
  data: {
    databaseFile: string;
    preferencesFile: string;
  };
  bundles: {
    common: {
      backend: string;
    };
  };
}

function relativeFromProjectRoot(projectRoot: string, targetPath: string): string {
  return path.relative(projectRoot, targetPath).split(path.sep).join("/");
}

interface CliPackageJson {
  files?: string[];
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const JAVASCRIPT_FILE = /\.(c|m)?js$/;

/** `@scope/name/sub/path` is the package `@scope/name`; `name/sub` is `name`. */
function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function isPackageSpecifier(specifier: string): boolean {
  // Relative and absolute paths, file: URLs and esbuild's own `<runtime>`.
  return !/^(\.|\/|<|file:|[a-zA-Z]:[\\/])/.test(specifier);
}

function isNodeBuiltin(specifier: string): boolean {
  return specifier.startsWith("node:") || builtinModules.includes(specifier);
}

function publishedJavaScript(cliDir: string, cliPackage: CliPackageJson): string[] {
  const found: string[] = [];
  const walk = (target: string): void => {
    if (!existsSync(target)) return;
    if (!statSync(target).isDirectory()) {
      if (JAVASCRIPT_FILE.test(target)) found.push(target);
      return;
    }
    for (const entry of readdirSync(target)) walk(path.join(target, entry));
  };
  for (const entry of cliPackage.files ?? []) walk(path.join(cliDir, entry));
  return found;
}

/**
 * Node must parse every published JavaScript file, and every package the
 * published CLI's JavaScript imports (`files` in
 * apps/cli/package.json: `bin/`, `dist/cli.js`, the backend bundle in
 * `bundles/`) must be a Node builtin or declared in apps/cli/package.json, or
 * `npm install deus-machine` leaves it out and the CLI cannot start. The
 * imports are read from the built files: esbuild walks them with every package
 * left external and reports each import it finds.
 *
 * An `import` or `require` runs when its file loads, so an undeclared one fails
 * the build. A dynamic `import()` fails only when the feature behind it is
 * used, so an undeclared one is reported and does not fail it.
 */
export function assertCliBundleDependencies(
  cliDir: string,
  log: (line: string) => void = console.log
): void {
  const cliPackage = JSON.parse(
    readFileSync(path.join(cliDir, "package.json"), "utf8")
  ) as CliPackageJson;
  const declared = new Set([
    ...Object.keys(cliPackage.dependencies ?? {}),
    ...Object.keys(cliPackage.optionalDependencies ?? {}),
    ...Object.keys(cliPackage.peerDependencies ?? {}),
  ]);

  const files = publishedJavaScript(cliDir, cliPackage);
  if (files.length === 0) {
    throw new Error(`No published JavaScript in ${cliDir}: build the CLI first`);
  }

  // Node must be able to parse each file (0.3.11 and 0.3.12 shipped a backend
  // bundle with `import.meta` in CommonJS, which it cannot).
  for (const file of files) {
    const check = spawnSync("node", ["--check", file], { encoding: "utf8" });
    if (check.status !== 0) {
      throw new Error(
        `Node cannot parse ${path.relative(cliDir, file)}:\n${(check.stderr || check.error?.message || "").trim()}`
      );
    }
  }

  const { metafile } = buildSync({
    entryPoints: files,
    absWorkingDir: cliDir,
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "esm",
    packages: "external",
    outdir: path.join(cliDir, "dependency-scan"),
    logLevel: "silent",
  });

  const onLoad = new Map<string, Set<string>>();
  const onUse = new Map<string, Set<string>>();
  for (const [input, { imports }] of Object.entries(metafile.inputs)) {
    for (const imported of imports) {
      if (!imported.external || !isPackageSpecifier(imported.path)) continue;
      if (isNodeBuiltin(imported.path)) continue;
      const name = packageNameOf(imported.path);
      if (declared.has(name)) continue;
      const missing = imported.kind === "dynamic-import" ? onUse : onLoad;
      missing.set(name, (missing.get(name) ?? new Set()).add(input));
    }
  }

  const describe = (missing: Map<string, Set<string>>): string =>
    [...missing].map(([name, from]) => `${name} (from ${[...from].join(", ")})`).join("; ");

  if (onUse.size > 0) {
    log(`! The CLI imports undeclared packages only when used: ${describe(onUse)}`);
  }
  if (onLoad.size > 0) {
    throw new Error(
      `The published CLI imports packages apps/cli/package.json does not declare: ${describe(onLoad)}`
    );
  }
  log(
    `✓ What the CLI imports as it loads is Node's or a declared dependency (${files.length} files)`
  );
}

export function stageRuntime(options: StageRuntimeOptions = {}): RuntimeManifest {
  const log = options.log ?? console.log;
  const projectRoot = options.projectRoot ?? defaultProjectRoot;
  const stagePaths = resolveRuntimeStagePaths(projectRoot);
  const sources = {
    backendBundle: path.join(projectRoot, "apps", "backend", "dist", "server.bundled.cjs"),
  };

  for (const [label, sourcePath] of Object.entries(sources)) {
    if (!existsSync(sourcePath)) {
      throw new Error(`Missing ${label}: ${sourcePath}`);
    }
  }

  if (options.preserveElectron === true) {
    rmSync(stagePaths.common.root, { recursive: true, force: true });
    rmSync(stagePaths.manifest, { force: true });
  } else {
    rmSync(stagePaths.root, { recursive: true, force: true });
  }

  mkdirSync(path.dirname(stagePaths.common.backendBundle), { recursive: true });

  cpSync(sources.backendBundle, stagePaths.common.backendBundle);

  const manifest: RuntimeManifest = {
    version: RUNTIME_MANIFEST_VERSION,
    appId: DEUS_APP_ID,
    data: {
      databaseFile: DEUS_DB_FILENAME,
      preferencesFile: DEUS_PREFERENCES_FILENAME,
    },
    bundles: {
      common: {
        backend: relativeFromProjectRoot(projectRoot, stagePaths.common.backendBundle),
      },
    },
  };

  writeFileSync(stagePaths.manifest, JSON.stringify(manifest, null, 2) + "\n");
  log(`✓ Runtime staged at ${relativeFromProjectRoot(projectRoot, stagePaths.root)}`);
  return manifest;
}
