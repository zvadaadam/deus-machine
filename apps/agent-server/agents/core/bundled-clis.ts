// agent-server/agents/core/bundled-clis.ts
// The desktop ships Claude and Codex. Their path overrides select the staged
// binaries ahead of the engine's pinned downloads. The engine downloads agy on first use.
// The runtime smoke checks the BUNDLED_CLI_PATH lines for the binaries the desktop ships.

import { delimiter } from "node:path";
import { getBundledCliDirectory, resolveBundledCliPath } from "@shared/lib/cli-path";

const TOOL_ENV = { claude: "CLAUDE_CLI_PATH", codex: "CODEX_CLI_PATH" } as const;

export function adoptBundledClis(): void {
  // Only in explicit runtime contexts (packaged app, dev.ts with a staged
  // dir). A plain dev launch must NOT pick up whatever stale artifact happens
  // to sit in dist/ — the engine's pinned provisioning is the dev source of
  // truth.
  const explicitRuntime =
    Boolean(process.env.DEUS_BUNDLED_BIN_DIR) || process.env.DEUS_PACKAGED === "1";
  if (!explicitRuntime) return;
  // Agents and terminals find the bundled CLIs (agent-device, gh, …) first,
  // in a checkout too, where PATH does not start with the staged folder.
  const bundledDir = getBundledCliDirectory();
  const path = (process.env.PATH ?? "").split(delimiter).filter((entry) => entry !== bundledDir);
  if (bundledDir) process.env.PATH = [bundledDir, ...path].join(delimiter);
  for (const tool of ["claude", "codex"] as const) {
    const bundled = resolveBundledCliPath(tool);
    if (!bundled) continue;
    // An explicit operator override still wins over the bundled binary.
    process.env[TOOL_ENV[tool]] ??= bundled;
    if (process.env.DEUS_PACKAGED === "1") {
      process.stdout.write(`BUNDLED_CLI_PATH ${tool}=${bundled}\n`);
    }
  }
}
