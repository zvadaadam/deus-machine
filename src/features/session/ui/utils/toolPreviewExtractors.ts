/**
 * Tool Preview Data Extractors
 *
 * Extracts scannable preview data from tool calls.
 * Each tool has a specific extractor that returns icon, verb, preview text, and stats.
 *
 * Design reference: CHAT_REDESIGN.md - Tool-Specific Preview Rules
 */

import {
  FileText,
  Pencil,
  Terminal,
  Search,
  CheckSquare,
  Brain,
  Bot,
  Wrench,
  File,
  Globe,
  FolderTree,
} from 'lucide-react';
import type { ToolUseBlock, ToolResultBlock } from '@/shared/types';
import type { ToolPreviewData } from '../components/ToolPreview';

/**
 * Get preview data for any tool
 */
export function getToolPreviewData(
  toolUse: ToolUseBlock,
  toolResult?: ToolResultBlock
): ToolPreviewData {
  const toolName = toolUse.name;

  // Route to specific extractor based on tool name
  switch (toolName) {
    case 'Read':
      return extractReadPreview(toolUse, toolResult);
    case 'Edit':
    case 'MultiEdit':
      return extractEditPreview(toolUse, toolResult);
    case 'Write':
      return extractWritePreview(toolUse, toolResult);
    case 'Bash':
      return extractBashPreview(toolUse, toolResult);
    case 'Grep':
      return extractGrepPreview(toolUse, toolResult);
    case 'Glob':
      return extractGlobPreview(toolUse, toolResult);
    case 'TodoWrite':
      return extractTodoPreview(toolUse, toolResult);
    case 'Task':
      return extractTaskPreview(toolUse, toolResult);
    case 'WebFetch':
    case 'WebSearch':
      return extractWebPreview(toolUse, toolResult);
    default:
      // Unknown tool - show generic preview
      return extractUnknownPreview(toolUse, toolResult);
  }
}

/**
 * Read Tool: "Read auth.ts • 45 lines"
 */
function extractReadPreview(toolUse: ToolUseBlock, toolResult?: ToolResultBlock): ToolPreviewData {
  const input = toolUse.input as any;
  const filePath = input?.file_path || 'unknown';
  const fileName = filePath.split('/').pop() || filePath;

  // Count lines from result
  let lineCount = 0;
  if (Array.isArray(toolResult?.content) && toolResult.content[0]?.type === 'text') {
    const textContent = toolResult.content[0] as any;
    const text = textContent.text;
    if (typeof text === 'string') {
      lineCount = text.split('\n').length;
    }
  }

  // Check if reading specific range
  const hasRange = input?.offset !== undefined || input?.limit !== undefined;
  const rangeText = hasRange
    ? `Lines ${input.offset || 0}-${(input.offset || 0) + (input.limit || 0)}`
    : `${lineCount} lines`;

  return {
    icon: FileText,
    verb: 'Read',
    preview: fileName,
    stats: rangeText,
    borderColor: 'primary',
  };
}

/**
 * Edit Tool: "Edit login.tsx • +12 -3"
 */
function extractEditPreview(toolUse: ToolUseBlock, toolResult?: ToolResultBlock): ToolPreviewData {
  const input = toolUse.input as any;
  const filePath = input?.file_path || 'unknown';
  const fileName = filePath.split('/').pop() || filePath;

  // Estimate changes (rough count based on old_string and new_string lengths)
  const oldLines = input?.old_string?.split('\n').length || 0;
  const newLines = input?.new_string?.split('\n').length || 0;
  const additions = Math.max(0, newLines - oldLines);
  const deletions = Math.max(0, oldLines - newLines);

  const stats = additions > 0 || deletions > 0
    ? `+${additions} -${deletions}`
    : 'modified';

  return {
    icon: Pencil,
    verb: 'Edit',
    preview: fileName,
    stats,
    borderColor: 'success',
  };
}

/**
 * Write Tool: "Write new-file.ts • created"
 */
function extractWritePreview(toolUse: ToolUseBlock, toolResult?: ToolResultBlock): ToolPreviewData {
  const input = toolUse.input as any;
  const filePath = input?.file_path || 'unknown';
  const fileName = filePath.split('/').pop() || filePath;

  const content = input?.content || '';
  const lineCount = content.split('\n').length;

  return {
    icon: File,
    verb: 'Write',
    preview: fileName,
    stats: `${lineCount} lines`,
    borderColor: 'success',
  };
}

/**
 * Bash Tool: "Run npm test • ✓ passed"
 */
function extractBashPreview(toolUse: ToolUseBlock, toolResult?: ToolResultBlock): ToolPreviewData {
  const input = toolUse.input as any;
  const command = input?.command || 'unknown';

  // Truncate long commands
  const shortCommand = command.length > 50 ? command.substring(0, 50) + '...' : command;

  // Check exit code from result
  let exitCode: number | null = null;
  let hasError = false;
  if (Array.isArray(toolResult?.content) && toolResult.content[0]?.type === 'text') {
    const textContent = toolResult.content[0] as any;
    const text = textContent.text;
    if (typeof text === 'string') {
      // Try to parse exit code (usually in format "Exit code: 0")
      const match = text.match(/exit code:?\s*(\d+)/i);
      if (match) {
        exitCode = parseInt(match[1]);
        hasError = exitCode !== 0;
      }
    }
  }

  const stats = exitCode !== null
    ? (exitCode === 0 ? '✓ success' : `✗ exit ${exitCode}`)
    : undefined;

  return {
    icon: Terminal,
    verb: 'Run',
    preview: shortCommand,
    stats,
    borderColor: 'warning',
  };
}

/**
 * Grep Tool: "Search 'pattern' • 5 matches"
 */
function extractGrepPreview(toolUse: ToolUseBlock, toolResult?: ToolResultBlock): ToolPreviewData {
  const input = toolUse.input as any;
  const pattern = input?.pattern || 'unknown';
  const shortPattern = pattern.length > 30 ? pattern.substring(0, 30) + '...' : pattern;

  // Count matches from result
  let matchCount = 0;
  if (Array.isArray(toolResult?.content) && toolResult.content[0]?.type === 'text') {
    const textContent = toolResult.content[0] as any;
    const text = textContent.text;
    if (typeof text === 'string') {
      matchCount = text.split('\n').filter((line: string) => line.trim()).length;
    }
  }

  return {
    icon: Search,
    verb: 'Search',
    preview: `"${shortPattern}"`,
    stats: `${matchCount} matches`,
    borderColor: 'primary',
  };
}

/**
 * Glob Tool: "Find *.tsx • 12 files"
 */
function extractGlobPreview(toolUse: ToolUseBlock, toolResult?: ToolResultBlock): ToolPreviewData {
  const input = toolUse.input as any;
  const pattern = input?.pattern || '*';

  // Count files from result
  let fileCount = 0;
  if (Array.isArray(toolResult?.content) && toolResult.content[0]?.type === 'text') {
    const textContent = toolResult.content[0] as any;
    const text = textContent.text;
    if (typeof text === 'string') {
      fileCount = text.split('\n').filter((line: string) => line.trim()).length;
    }
  }

  return {
    icon: FolderTree,
    verb: 'Find',
    preview: pattern,
    stats: `${fileCount} files`,
    borderColor: 'primary',
  };
}

/**
 * TodoWrite Tool: "Updated todos • 3/5 complete"
 */
function extractTodoPreview(toolUse: ToolUseBlock, toolResult?: ToolResultBlock): ToolPreviewData {
  const input = toolUse.input as any;
  const todos = input?.todos || [];

  const totalCount = todos.length;
  const completedCount = todos.filter((t: any) => t.status === 'completed').length;
  const inProgressTodo = todos.find((t: any) => t.status === 'in_progress');

  const preview = inProgressTodo
    ? `${inProgressTodo.content.substring(0, 30)}${inProgressTodo.content.length > 30 ? '...' : ''}`
    : 'No active task';

  return {
    icon: CheckSquare,
    verb: 'Updated todos',
    preview,
    stats: `${completedCount}/${totalCount} done`,
    borderColor: 'primary',
  };
}

/**
 * Task (Agent) Tool: "Started agent • general-purpose"
 */
function extractTaskPreview(toolUse: ToolUseBlock, toolResult?: ToolResultBlock): ToolPreviewData {
  const input = toolUse.input as any;
  const agentType = input?.subagent_type || 'unknown';
  const description = input?.description || '';

  return {
    icon: Bot,
    verb: 'Started agent',
    preview: description || agentType,
    stats: agentType,
    borderColor: 'primary',
  };
}

/**
 * Web Tools: "Fetch • example.com"
 */
function extractWebPreview(toolUse: ToolUseBlock, toolResult?: ToolResultBlock): ToolPreviewData {
  const input = toolUse.input as any;
  const url = input?.url || input?.query || 'unknown';

  // Extract domain from URL
  let domain = url;
  try {
    const urlObj = new URL(url);
    domain = urlObj.hostname;
  } catch {
    // If not a valid URL, truncate
    domain = url.length > 40 ? url.substring(0, 40) + '...' : url;
  }

  const verb = toolUse.name === 'WebSearch' ? 'Search' : 'Fetch';

  return {
    icon: Globe,
    verb,
    preview: domain,
    borderColor: 'primary',
  };
}

/**
 * Unknown Tool: "tool-name • View details →"
 */
function extractUnknownPreview(toolUse: ToolUseBlock, toolResult?: ToolResultBlock): ToolPreviewData {
  return {
    icon: Wrench,
    verb: toolUse.name,
    preview: 'View details →',
    borderColor: 'muted',
  };
}
