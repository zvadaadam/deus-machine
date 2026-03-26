// agent-server/agents/environment/index.ts
// Barrel re-export for all environment-related modules.

export { parseEnvString, buildAgentEnvironment } from "./env-builder";
export { getShellEnvironment } from "./shell-env";
export { getProjectName, buildWorkspaceContext } from "./workspace-context";
export {
  discoverExecutable,
  blockIfNotInitialized,
  type DiscoveryConfig,
  type DiscoveryState,
} from "./cli-discovery";
