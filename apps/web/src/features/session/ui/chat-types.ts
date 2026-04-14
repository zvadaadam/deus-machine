/**
 * Chat Component Types
 *
 * Type definitions for chat components and tool renderers
 */

import type { ToolUseBlock, ToolResultBlock } from "@/shared/types";

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
