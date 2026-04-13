/**
 * Turn Statistics Calculator
 *
 * Analyzes assistant turn messages to extract aggregated statistics:
 * - Tool call counts (total and per-subagent)
 * - File changes (unique files affected)
 *
 * Used by AssistantTurn component to display collapsed summary.
 */

import type { Message } from "@/shared/types";
import type { ToolPart } from "@shared/messages/types";

export interface TurnStats {
  toolCount: number;
  subagentCount: number;
  filesChanged: number;
}

const FILE_MODIFYING_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function getToolInputFilePath(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const filePath = (input as { file_path?: unknown }).file_path;
  return typeof filePath === "string" && filePath.length > 0 ? filePath : null;
}

export function calculateTurnStats(messages: Message[]): TurnStats {
  let toolCount = 0;
  let subagentCount = 0;
  const fileSet = new Set<string>();

  for (const message of messages) {
    if (!message.parts) continue;

    for (const part of message.parts) {
      if (part.type !== "TOOL") continue;
      toolCount++;

      const toolPart = part as ToolPart;
      if (toolPart.toolName === "Task" || toolPart.toolName === "Agent") {
        subagentCount++;
      }

      if (FILE_MODIFYING_TOOLS.has(toolPart.toolName) && toolPart.state.status === "COMPLETED") {
        const filePath = getToolInputFilePath(toolPart.state.input);
        if (filePath) {
          fileSet.add(filePath);
        }
      }
    }
  }

  return { toolCount, subagentCount, filesChanged: fileSet.size };
}
