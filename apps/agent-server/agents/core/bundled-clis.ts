// agent-server/agents/core/bundled-clis.ts
// Packaged/staged runtimes bundle the native agent CLIs (claude, codex) inside
// the app — the engine must use those instead of downloading pins (packaged
// apps run offline). The engine's operator overrides ($CLAUDE_CLI_PATH /
// $CODEX_CLI_PATH) beat its pinned provisioning, so adopting the bundled
// binaries is just setting those envs before the registry is built.
//
// The `BUNDLED_CLI_PATH <tool>=<path>` startup lines are a runtime-smoke
// contract (scripts/runtime/smoke) carried over from the legacy discovery:
// packaged CI asserts the server found the staged binaries.

import { resolveBundledCliPath } from "@shared/lib/cli-path";

const TOOL_ENV = { claude: "CLAUDE_CLI_PATH", codex: "CODEX_CLI_PATH" } as const;

export function adoptBundledClis(): void {
  for (const tool of ["claude", "codex"] as const) {
    const bundled = resolveBundledCliPath(tool);
    if (!bundled) continue;
    // An explicit operator override still wins over the bundled binary.
    process.env[TOOL_ENV[tool]] ??= bundled;
    if (process.env.DEUS_RUNTIME === "1" || process.env.DEUS_PACKAGED === "1") {
      process.stdout.write(`BUNDLED_CLI_PATH ${tool}=${bundled}\n`);
    }
  }
}
