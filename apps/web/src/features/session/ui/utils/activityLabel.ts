import { toolCardName } from "@shared/mcp-servers";
import type { Part } from "@shared/protocol-types";

const FILE_MODIFYING_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export function activityLabel(parts: readonly Part[], streaming: boolean): string {
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
      const filePath = part.state.input?.file_path;
      if (typeof filePath === "string" && filePath) fileSet.add(filePath);
    }
  }

  let label = toolCount || parts.some((part) => part.type === "text") ? "Activity" : "Reasoning";
  if (streaming) {
    const active = parts.findLast(
      (part) =>
        ((part.type === "reasoning" || part.type === "text") && part.state === "streaming") ||
        (part.type === "tool" &&
          (part.state.status === "pending" || part.state.status === "in_progress"))
    );
    if (active?.type === "tool")
      label =
        active.title ||
        (active.state.status === "in_progress" && active.state.title) ||
        toolCardName(active);
    else if (active?.type === "reasoning") label = "Thinking";
    else if (active?.type === "text") label = "Typing…";
  }
  return [
    label,
    subagentCount && `${subagentCount} subagent${subagentCount === 1 ? "" : "s"}`,
    toolCount && `${toolCount} tool call${toolCount === 1 ? "" : "s"}`,
    !toolCount && parts.length > 1 && `${parts.length} steps`,
    fileSet.size && `${fileSet.size} file${fileSet.size === 1 ? "" : "s"} changed`,
  ]
    .filter(Boolean)
    .join(" · ");
}
