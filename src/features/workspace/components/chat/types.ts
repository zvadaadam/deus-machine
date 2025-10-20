/**
 * Chat Component Types
 *
 * Type definitions for chat components and tool renderers
 */

import type { ToolUseBlock, ToolResultBlock } from '@/types';

/**
 * Props for tool renderer components
 */
export interface ToolRendererProps {
  toolUse: ToolUseBlock;
  toolResult?: ToolResultBlock;
}

/**
 * Tool renderer component type
 */
export type ToolRenderer = React.ComponentType<ToolRendererProps>;

/**
 * Tool metadata
 */
export interface ToolMetadata {
  name: string;
  icon?: string;
  color?: 'default' | 'success' | 'error' | 'info';
  description?: string;
}
