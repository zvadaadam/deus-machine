/**
 * Turn Statistics Calculator
 *
 * Analyzes assistant turn messages to extract aggregated statistics:
 * - Tool call counts (total and per-subagent)
 * - File changes (unique files affected)
 *
 * Used by AssistantTurn component to display collapsed summary.
 */

import type { Message, ContentBlock } from "@/shared/types";
import { isToolUseBlock } from "@shared/types/session";

export interface TurnStats {
  toolCount: number;
  subagentCount: number;
  filesChanged: number;
}

interface ParseContentFn {
  (content: string): (ContentBlock | string)[] | string | null;
}

/**
 * Calculate statistics for an assistant turn
 *
 * @param messages - Array of assistant messages in this turn
 * @param parseContent - Function to parse message content JSON
 * @returns Aggregated statistics for the turn
 */
export function calculateTurnStats(messages: Message[], parseContent: ParseContentFn): TurnStats {
  let toolCount = 0;
  let subagentCount = 0;
  const fileSet = new Set<string>();

  for (const message of messages) {
    // Parts-based counting (new unified model)
    if (message.parts && message.parts.length > 0) {
      for (const partRow of message.parts) {
        if (partRow.type !== "TOOL") continue;
        toolCount++;

        const toolName = partRow.tool_name;
        if (toolName === "Task" || toolName === "Agent") {
          subagentCount++;
        }

        // Extract file path from part data for file change tracking
        try {
          const data = JSON.parse(partRow.data);
          const input = data?.state?.input;
          const filePath = input?.file_path;
          if (typeof filePath === "string" && filePath.length > 0) {
            fileSet.add(filePath);
          }
        } catch {
          // Ignore parse errors
        }
      }
      continue;
    }

    // Legacy content-based counting (fallback)
    const contentBlocks = parseContent(message.content);
    if (!Array.isArray(contentBlocks)) continue;

    for (const block of contentBlocks) {
      if (typeof block === "string") continue;
      if (!isToolUseBlock(block)) continue;

      toolCount++;

      if (block.name === "Task" || block.name === "Agent") {
        subagentCount++;
      }

      const filePath = block.input?.file_path;
      if (typeof filePath === "string" && filePath.length > 0) {
        fileSet.add(filePath);
      }
    }
  }

  return { toolCount, subagentCount, filesChanged: fileSet.size };
}
