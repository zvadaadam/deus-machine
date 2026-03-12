/**
 * Turn Statistics Calculator
 *
 * Analyzes assistant turn messages to extract aggregated statistics:
 * - Tool call counts (total and breakdown by tool type)
 * - File changes (unique files affected)
 * - Error counts
 *
 * Used by AssistantTurn component to display collapsed summary.
 */

import type { Message, ContentBlock, ToolUseBlock, ToolResultBlock } from "@/shared/types";
import { isToolUseBlock } from "@shared/types/session";

export interface TurnStats {
  toolCount: number;
  subagentCount: number;
  filesChanged: number;
  errorCount: number;
  toolBreakdown: Record<string, number>; // e.g., { Edit: 3, Read: 2, Bash: 3 }
  fileList: string[]; // List of unique file paths
}

interface ParseContentFn {
  (content: string): (ContentBlock | string)[] | string | null;
}

/**
 * Calculate statistics for an assistant turn
 *
 * @param messages - Array of assistant messages in this turn
 * @param parseContent - Function to parse message content JSON
 * @param toolResultMap - Map of tool_use_id to ToolResultBlock for error detection
 * @returns Aggregated statistics for the turn
 */
export function calculateTurnStats(
  messages: Message[],
  parseContent: ParseContentFn,
  toolResultMap: Map<string, ToolResultBlock>
): TurnStats {
  const stats: TurnStats = {
    toolCount: 0,
    subagentCount: 0,
    filesChanged: 0,
    errorCount: 0,
    toolBreakdown: {},
    fileList: [],
  };

  const fileSet = new Set<string>();

  messages.forEach((message) => {
    const contentBlocks = parseContent(message.content);

    // Handle non-array content gracefully
    if (!Array.isArray(contentBlocks)) {
      return;
    }

    contentBlocks.forEach((block) => {
      // Skip string blocks
      if (typeof block === "string") {
        return;
      }

      // Count tool_use blocks
      if (isToolUseBlock(block)) {
        const toolUse = block;
        stats.toolCount++;

        // Count subagents (Task/Agent tool_use blocks)
        if (toolUse.name === "Task" || toolUse.name === "Agent") {
          stats.subagentCount++;
        }

        // Track tool breakdown
        stats.toolBreakdown[toolUse.name] = (stats.toolBreakdown[toolUse.name] || 0) + 1;

        // Track file changes from tool input
        if (toolUse.input?.file_path) {
          fileSet.add(toolUse.input.file_path);
        }

        // Check for errors in tool results
        const toolResult = toolResultMap.get(toolUse.id);
        if (toolResult?.is_error) {
          stats.errorCount++;
        }
      }
    });
  });

  stats.filesChanged = fileSet.size;
  stats.fileList = Array.from(fileSet);

  return stats;
}
