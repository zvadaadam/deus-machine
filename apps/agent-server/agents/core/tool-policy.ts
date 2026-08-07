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
import type { ClaudeToolPolicy } from "@agent-server/core";
import { EventBroadcaster } from "../../event-broadcaster";
import { sessions } from "./session-state";

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

function realpathOrResolve(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
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
      return { behavior: "deny", message: "Plan was not approved", interrupt: false };
    } catch {
      return { behavior: "deny", message: "Plan approval unavailable", interrupt: false };
    }
  }

  if (EDIT_TOOLS.has(toolName)) {
    const state = sessions.get(ctx.sessionId);
    const cwd = state?.cwd;
    const filePath = String(input.file_path ?? input.notebook_path ?? "");
    if (cwd && filePath) {
      const allowed = [cwd, ...(state?.lastOptions?.additionalDirectories ?? [])].map(
        realpathOrResolve
      );
      const target = realpathOrResolve(filePath);
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
