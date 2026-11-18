import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stageRuntime } from "./stage";
import { prepareAgentClis } from "./agent-clis";
import { buildDeusRuntime } from "./native-runtime";

const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(runtimeDir, "../..");

function prepareGhCli(): void {
  execFileSync("node", [path.join(projectRoot, "scripts", "prepare-gh-cli.mjs")], {
    cwd: projectRoot,
    stdio: "inherit",
  });
}

try {
  console.log("Staging shared runtime...\n");
  stageRuntime();
  // deus-runtime compiles the Simulator tab's engine bundle in: build it from
  // source here, since install keeps whatever dist/engine.js a checkout had.
  execFileSync("bun", ["run", "build:ts"], {
    cwd: path.join(projectRoot, "packages/device-use"),
    stdio: "inherit",
  });
  buildDeusRuntime();
  await prepareAgentClis();
  prepareGhCli();
} catch (error) {
  console.error("Runtime staging failed:", error);
  process.exit(1);
}
