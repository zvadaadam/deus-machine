/**
 * Chat Component Types
 *
 * Type definitions for chat components and tool renderers
 */

import type { ToolUseBlock, ToolResultBlock } from "@/shared/types";

/**
 * Map of tool_use_id to ToolResultBlock
 * Used to link tool_use blocks with their corresponding tool_result blocks
 */
export type ToolResultMap = Map<string, ToolResultBlock>;

/**
 * Props for tool renderer components
 */
export interface ToolRendererProps {
  toolUse: ToolUseBlock;
  toolResult?: ToolResultBlock;
  isLoading?: boolean;
}

/**
 * Tool renderer component type
 */
export type ToolRenderer = React.ComponentType<ToolRendererProps>;
