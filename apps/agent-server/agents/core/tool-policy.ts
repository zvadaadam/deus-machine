// agent-server/agents/core/tool-policy.ts
// Deus's answers to Claude tool-use questions, ported from the legacy
// canUseTool. Deus has no interactive permission UI, so nothing may fall
// through to the engine's broker — an unanswered `permission.requested` parks
// the turn forever. Policy:
//   - ExitPlanMode rides deus's broadcaster round-trip;
//   - edit tools are denied outside cwd + additionalDirectories;
//   - everything else is allowed.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ClaudeToolPolicy } from "@zvada/agent-server/core";
import { EventBroadcaster } from "../../event-broadcaster";
import { sessions } from "./session-state";

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

function realpathOrResolve(p: string, base?: string): string {
  const absolute = base ? path.resolve(base, p) : path.resolve(p);
  // New files don't exist yet: walk up to the deepest EXISTING ancestor,
  // realpath that, and re-append the remainder. Without the walk, a new file
  // written through an in-workspace symlink (cwd/link/new.ts with
  // link -> outside) keeps the cwd prefix and escapes the guard, and a
  // workspace that itself sits behind a symlink (/tmp on macOS) false-denies.
  let dir = absolute;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(dir);
      return tail.length ? path.join(real, ...tail) : real;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return absolute;
      tail.unshift(path.basename(dir));
      dir = parent;
    }
  }
}

export const decideToolUse: ClaudeToolPolicy = async (toolName, input, ctx) => {
  if (toolName === "ExitPlanMode") {
    try {
      const response = await EventBroadcaster.requestExitPlanMode({
        sessionId: ctx.sessionId,
        toolInput: input,
      });
      if (response.approved) {
        return {
          behavior: "allow",
          updatedInput: input,
          updatedPermissions: [{ type: "setMode", mode: "default", destination: "session" }],
        };
      }
      // interrupt: the user rejected the plan and will send an explanation —
      // the agent must stop this turn, not keep planning (legacy parity).
      return {
        behavior: "deny",
        message: "Plan denied by user. Please await a further message for an explanation.",
        interrupt: true,
      };
    } catch {
      return {
        behavior: "deny",
        message:
          "Plan approval request failed (frontend may be unavailable or timed out). " +
          "Please wait for the user to reconnect and try again.",
        interrupt: true,
      };
    }
  }

  if (EDIT_TOOLS.has(toolName)) {
    const state = sessions.get(ctx.sessionId);
    const cwd = state?.cwd;
    const filePath = String(input.file_path ?? input.notebook_path ?? "");
    if (!cwd) {
      // Fail closed: without a session cwd there is no allowed-directory set
      // to check against (should be unreachable — every query records it).
      return { behavior: "deny", message: "Edit rejected: session working directory unknown." };
    }
    if (filePath) {
      const allowed = [cwd, ...(state?.lastOptions?.additionalDirectories ?? [])].map((dir) =>
        realpathOrResolve(dir)
      );
      // Relative tool paths are relative to the AGENT's cwd, not this process.
      const target = realpathOrResolve(filePath, cwd);
      if (!allowed.some((dir) => target === dir || target.startsWith(dir + path.sep))) {
        return {
          behavior: "deny",
          message: `Cannot edit files outside allowed directories (${allowed.join(", ")}). Attempted: ${filePath}`,
        };
      }
    }
  }

  return { behavior: "allow", updatedInput: input };
};
