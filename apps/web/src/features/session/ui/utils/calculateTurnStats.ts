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

      // Extract file path from tool input for file change tracking
      const input = toolPart.state.status !== "PENDING" ? (toolPart.state as any).input : null;
      const filePath = input?.file_path;
      if (typeof filePath === "string" && filePath.length > 0) {
        fileSet.add(filePath);
      }
    }
  }

  return { toolCount, subagentCount, filesChanged: fileSet.size };
}
