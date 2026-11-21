import type { Part } from "@shared/protocol-types";

const FILE_MODIFYING_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function getToolInputFilePath(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const filePath = (input as { file_path?: unknown }).file_path;
  return typeof filePath === "string" && filePath.length > 0 ? filePath : null;
}

export function calculateTurnStats(parts: readonly Part[]) {
  let toolCount = 0;
  let subagentCount = 0;
  const fileSet = new Set<string>();

  for (const part of parts) {
    if (part.type !== "tool") continue;
    toolCount++;
    if (part.kind === "task" || part.subagent) subagentCount++;
    if (part.state.status !== "completed") continue;
    if (part.toolName === "apply_patch") {
      for (const item of part.state.content ?? []) {
        if (item.type === "diff") fileSet.add(item.path);
      }
    } else if (FILE_MODIFYING_TOOLS.has(part.toolName)) {
      const filePath = getToolInputFilePath(part.state.input);
      if (filePath) fileSet.add(filePath);
    }
  }

  return { toolCount, subagentCount, filesChanged: fileSet.size };
}
