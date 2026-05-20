import { prepareAgentClis } from "./agent-clis";

type AgentCliRuntimeKey = "darwin-arm64" | "darwin-x64" | "linux-x64";

function getHostRuntimeKey(): AgentCliRuntimeKey | null {
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  if (process.platform === "darwin" && process.arch === "x64") return "darwin-x64";
  if (process.platform === "linux" && process.arch === "x64") return "linux-x64";
  return null;
}

const runtimeKey = getHostRuntimeKey();
if (!runtimeKey) {
  console.warn(
    `[dev] Unsupported platform for bundled agent CLI staging: ${process.platform}-${process.arch}`
  );
  process.exit(0);
}

await prepareAgentClis({
  runtimeKeys: [runtimeKey],
  verifyRunnable: process.env.DEUS_VERIFY_AGENT_CLI_RUNNABLE === "1",
  writeManifest: false,
});
