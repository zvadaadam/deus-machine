// agent-server/agents/core/tool-policy.ts
// Deus's answers to Claude tool-use questions, ported from the legacy
// canUseTool. Policy:
//   - ExitPlanMode and AskUserQuestion go to the engine, which puts them to
//     the user as Codex's (`permission.requested`, `elicitation.requested`);
//     the backend answers from the plan and question cards
//     (shared/agent-asks.ts);
//   - edit tools are denied outside cwd + additionalDirectories;
//   - everything else is allowed.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ClaudeToolPolicy } from "@zvada/agent-server/core";
import { trackedSessions } from "../../session-tracker";

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
  if (toolName === "ExitPlanMode" || toolName === "AskUserQuestion") return undefined;

  if (EDIT_TOOLS.has(toolName)) {
    const state = trackedSessions.get(ctx.sessionId);
    const cwd = state?.cwd;
    const filePath = String(input.file_path ?? input.notebook_path ?? "");
    if (!cwd) {
      // Fail closed: without a session cwd there is no allowed-directory set
      // to check against (should be unreachable — every turn/start records it).
      return { behavior: "deny", message: "Edit rejected: session working directory unknown." };
    }
    if (filePath) {
      const allowed = [cwd, ...(state?.additionalDirectories ?? [])].map((dir) =>
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
