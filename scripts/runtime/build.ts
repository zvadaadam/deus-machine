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
  const manifest = stageRuntime();
  await Promise.resolve(buildDeusRuntime());
  await prepareAgentClis({
    verifyRunnable: process.env.DEUS_VERIFY_AGENT_CLI_RUNNABLE === "1",
  });
  prepareGhCli();
  console.log(`\n✓ Runtime manifest written (${manifest.version})`);
} catch (error) {
  console.error("Runtime staging failed:", error);
  process.exit(1);
}
