/**
 * Tool Categorization Utilities
 *
 * Categorizes tools by their semantic meaning and risk level.
 * Used for visual styling and generating turn summaries.
 */

import type { ToolUseBlock } from '@/shared/types';

/**
 * Tool category types based on semantic meaning
 */
export type ToolCategory = 'read' | 'write' | 'execute' | 'search' | 'utility' | 'agent';

/**
 * Tool metadata for visual styling
 */
export interface ToolMetadata {
  category: ToolCategory;
  iconColor: 'info' | 'primary' | 'warning' | 'muted';
  borderColor: 'info' | 'primary' | 'warning' | 'border';
  defaultExpanded: boolean;
}

/**
 * Tool categorization map
 */
const TOOL_CATEGORIES: Record<string, ToolMetadata> = {
  // Read operations (low risk, informational)
  'Read': {
    category: 'read',
    iconColor: 'info',
    borderColor: 'info',
    defaultExpanded: false,
  },
  'Glob': {
    category: 'search',
    iconColor: 'muted',
    borderColor: 'border',
    defaultExpanded: false,
  },
  'Grep': {
    category: 'search',
    iconColor: 'muted',
    borderColor: 'border',
    defaultExpanded: false,
  },
  'LS': {
    category: 'read',
    iconColor: 'info',
    borderColor: 'info',
    defaultExpanded: false,
  },

  // Write operations (medium risk, important)
  'Edit': {
    category: 'write',
    iconColor: 'primary',
    borderColor: 'primary',
    defaultExpanded: true,
  },
  'Write': {
    category: 'write',
    iconColor: 'primary',
    borderColor: 'primary',
    defaultExpanded: true,
  },
  'MultiEdit': {
    category: 'write',
    iconColor: 'primary',
    borderColor: 'primary',
    defaultExpanded: true,
  },

  // Execute operations (high risk, requires attention)
  'Bash': {
    category: 'execute',
    iconColor: 'warning',
    borderColor: 'warning',
    defaultExpanded: true,
  },
  'BashOutput': {
    category: 'execute',
    iconColor: 'warning',
    borderColor: 'warning',
    defaultExpanded: true,
  },
  'KillShell': {
    category: 'execute',
    iconColor: 'warning',
    borderColor: 'warning',
    defaultExpanded: true,
  },

  // Search/Query operations
  'WebSearch': {
    category: 'search',
    iconColor: 'muted',
    borderColor: 'border',
    defaultExpanded: false,
  },
  'WebFetch': {
    category: 'search',
    iconColor: 'muted',
    borderColor: 'border',
    defaultExpanded: false,
  },

  // Agent/Task operations
  'Task': {
    category: 'agent',
    iconColor: 'primary',
    borderColor: 'primary',
    defaultExpanded: true,
  },

  // Utility operations
  'TodoWrite': {
    category: 'utility',
    iconColor: 'muted',
    borderColor: 'border',
    defaultExpanded: false,
  },
};

/**
 * Get metadata for a tool
 */
export function getToolMetadata(toolName: string): ToolMetadata {
  return TOOL_CATEGORIES[toolName] || {
    category: 'utility',
    iconColor: 'muted',
    borderColor: 'border',
    defaultExpanded: false,
  };
}

/**
 * Categorize tool blocks by action type
 */
export function categorizeTools(toolBlocks: ToolUseBlock[]) {
  const categories = {
    read: [] as ToolUseBlock[],
    write: [] as ToolUseBlock[],
    execute: [] as ToolUseBlock[],
    search: [] as ToolUseBlock[],
    utility: [] as ToolUseBlock[],
    agent: [] as ToolUseBlock[],
  };

  toolBlocks.forEach(tool => {
    const metadata = getToolMetadata(tool.name);
    categories[metadata.category].push(tool);
  });

  return categories;
}

/**
 * Generate a human-readable summary of tools executed
 * e.g., "Read 3 files, Edited 2 files, Ran 1 command"
 */
export function generateToolSummary(toolBlocks: ToolUseBlock[]): string {
  if (toolBlocks.length === 0) {
    return 'No tools executed';
  }

  const categories = categorizeTools(toolBlocks);
  const parts: string[] = [];

  // Read operations
  if (categories.read.length > 0) {
    parts.push(`Read ${categories.read.length} file${categories.read.length === 1 ? '' : 's'}`);
  }

  // Write operations
  if (categories.write.length > 0) {
    const editCount = categories.write.filter(t => t.name === 'Edit' || t.name === 'MultiEdit').length;
    const writeCount = categories.write.filter(t => t.name === 'Write').length;

    if (editCount > 0) {
      parts.push(`Edited ${editCount} file${editCount === 1 ? '' : 's'}`);
    }
    if (writeCount > 0) {
      parts.push(`Wrote ${writeCount} file${writeCount === 1 ? '' : 's'}`);
    }
  }

  // Execute operations
  if (categories.execute.length > 0) {
    parts.push(`Ran ${categories.execute.length} command${categories.execute.length === 1 ? '' : 's'}`);
  }

  // Search operations
  if (categories.search.length > 0) {
    parts.push(`Searched ${categories.search.length} time${categories.search.length === 1 ? '' : 's'}`);
  }

  // Agent operations
  if (categories.agent.length > 0) {
    parts.push(`Started ${categories.agent.length} task${categories.agent.length === 1 ? '' : 's'}`);
  }

  // Utility operations (only show if nothing else happened)
  if (parts.length === 0 && categories.utility.length > 0) {
    parts.push(`${categories.utility.length} action${categories.utility.length === 1 ? '' : 's'}`);
  }

  return parts.join(', ');
}
