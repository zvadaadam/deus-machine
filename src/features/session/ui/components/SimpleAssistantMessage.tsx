/**
 * Simple Assistant Message
 *
 * Clean, scannable display of assistant actions.
 * - Text blocks: Markdown rendered
 * - Tool calls: Collapsible preview cards
 * - Thinking: Expandable full text
 *
 * Design: No duplication, show preview collapsed, content expanded.
 */

import { useState } from 'react';
import type { ContentBlock, ToolUseBlock, TextBlock as TextBlockType, ThinkingBlock as ThinkingBlockType } from '@/shared/types';
import { useSession } from '../../context';
import { FileText, Pencil, Terminal, Search, FolderOpen, CheckSquare, Brain, Globe, ExternalLink, Zap, ChevronRight } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { TextBlock } from '../blocks/TextBlock';
import { CodeBlock } from '../tools/components/CodeBlock';
import { detectLanguageFromPath } from '../tools/utils/detectLanguage';

interface SimpleAssistantMessageProps {
  contentBlocks: (ContentBlock | string)[];
  messageId: string;
}

// Map tool names to icons
const getToolIcon = (toolName: string) => {
  switch (toolName) {
    case 'Read':
      return FileText;
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
      return Pencil;
    case 'Bash':
    case 'BashOutput':
    case 'KillShell':
      return Terminal;
    case 'Grep':
    case 'WebSearch':
      return Search;
    case 'Glob':
      return FolderOpen;
    case 'TodoWrite':
      return CheckSquare;
    case 'WebFetch':
      return Globe;
    case 'Task':
      return Zap;
    default:
      return ExternalLink;
  }
};

// Get concise preview for collapsed state
const getToolPreview = (toolBlock: ToolUseBlock, toolResult: any): { text: string; isPath?: boolean; diffStats?: { added: number; removed: number } } => {
  const input = toolBlock.input as any;

  switch (toolBlock.name) {
    case 'Read': {
      const filePath = input?.file_path || '';
      const fileName = filePath.split('/').pop() || filePath;

      // Count lines from result
      if (toolResult?.content) {
        const content = Array.isArray(toolResult.content) ? toolResult.content[0]?.text : toolResult.content;
        if (typeof content === 'string') {
          const lineCount = content.split('\n').length;
          return { text: `${fileName} • ${lineCount} lines`, isPath: true };
        }
      }
      return { text: fileName, isPath: true };
    }

    case 'Edit':
    case 'Write':
    case 'MultiEdit': {
      const filePath = input?.file_path || '';
      const fileName = filePath.split('/').pop() || filePath;

      // Calculate diff stats for Edit (will be colored in render)
      if (toolBlock.name === 'Edit' && input?.old_string && input?.new_string) {
        const oldLines = input.old_string.split('\n').length;
        const newLines = input.new_string.split('\n').length;
        const added = Math.max(0, newLines - oldLines);
        const removed = Math.max(0, oldLines - newLines);

        if (added > 0 || removed > 0) {
          return { text: `${fileName} • `, isPath: true, diffStats: { added, removed } };
        }
      }

      return { text: fileName, isPath: true };
    }

    case 'Bash':
    case 'BashOutput': {
      // Use description if available (e.g., "Delete TurnHeader.tsx (dead code)")
      const description = input?.description || '';
      if (description) {
        return { text: description };
      }

      // Fallback to command if no description
      const command = input?.command || '';
      const shortCmd = command.length > 50 ? command.substring(0, 50) + '...' : command;
      return { text: shortCmd };
    }

    case 'Grep':
    case 'Glob': {
      const pattern = input?.pattern || '';
      return { text: `"${pattern}"` };
    }

    case 'TodoWrite': {
      const todos = input?.todos || [];
      return { text: `${todos.length} items` };
    }

    default:
      return { text: '' };
  }
};

// Extract actual content from tool result for expanded state
const getToolContent = (toolBlock: ToolUseBlock, toolResult: any): string | null => {
  if (!toolResult || toolResult.is_error) {
    return toolResult?.error || 'Error occurred';
  }

  // Special handling for Bash: show command + output
  if (toolBlock.name === 'Bash') {
    const command = (toolBlock.input as any)?.command || '';
    let output = '';

    // Extract output from result
    if (Array.isArray(toolResult.content)) {
      const firstContent = toolResult.content[0];
      if (firstContent?.type === 'text') {
        output = firstContent.text;
      }
    } else if (typeof toolResult.content === 'string') {
      output = toolResult.content;
    }

    // Format as: $ command\n\noutput
    return `$ ${command}\n\n${output}`;
  }

  // Handle different content formats for other tools
  if (Array.isArray(toolResult.content)) {
    const firstContent = toolResult.content[0];
    if (firstContent?.type === 'text') {
      return firstContent.text;
    }
  }

  if (typeof toolResult.content === 'string') {
    return toolResult.content;
  }

  if (typeof toolResult.content === 'object') {
    return JSON.stringify(toolResult.content, null, 2);
  }

  return null;
};

// Tool Preview Card Component
function ToolPreviewCard({
  toolBlock,
  toolResult
}: {
  toolBlock: ToolUseBlock;
  toolResult: any;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const Icon = getToolIcon(toolBlock.name);
  const preview = getToolPreview(toolBlock, toolResult);
  const content = getToolContent(toolBlock, toolResult);
  const isError = toolResult?.is_error;

  return (
    <div className="flex flex-col gap-1">
      {/* Collapsible header - clean, no background */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={cn(
          "flex items-center gap-2 px-2 py-1.5 text-[13px]",
          "text-left w-full cursor-pointer",
          "transition-opacity duration-200 hover:opacity-80"
        )}
      >
        <ChevronRight
          className={cn(
            "w-3 h-3 text-muted-foreground/50 transition-transform duration-200 flex-shrink-0",
            isExpanded && "rotate-90"
          )}
        />
        <Icon className={cn(
          "w-4 h-4 flex-shrink-0",
          isError ? "text-destructive" : "text-muted-foreground/70"
        )} />
        <span className="font-medium">{toolBlock.name}</span>
        {isError && (
          <span className="text-destructive text-[11px] font-medium">✗ Error</span>
        )}
        {preview.text && (
          <span className={cn(
            "truncate text-[12px]",
            preview.isPath ? "font-mono text-muted-foreground" : "text-muted-foreground"
          )}>
            {preview.text}
            {/* Colored diff stats */}
            {preview.diffStats && (
              <>
                <span className="text-green-600">+{preview.diffStats.added}</span>
                {' '}
                <span className="text-red-600">-{preview.diffStats.removed}</span>
              </>
            )}
          </span>
        )}
      </button>

      {/* Expanded content - ONLY the actual content, no duplicate header */}
      {isExpanded && content && (
        <div className="ml-5 mt-1">
          {isError ? (
            <div className="text-[13px] text-destructive bg-destructive/5 p-2 rounded border border-destructive/20">
              {content}
            </div>
          ) : (
            <CodeBlock
              code={content}
              language={toolBlock.name === 'Read' ? detectLanguageFromPath(String((toolBlock.input as any)?.file_path || '')) : undefined}
              showLineNumbers={toolBlock.name === 'Read'}
              maxHeight="400px"
            />
          )}
        </div>
      )}
    </div>
  );
}

// Thinking Card Component
function ThinkingCard({
  thinkingBlock
}: {
  thinkingBlock: ThinkingBlockType;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const fullText = thinkingBlock.thinking || '';

  // Width-based preview: show first ~120 characters
  const PREVIEW_CHAR_LIMIT = 120;
  const preview = fullText.length > PREVIEW_CHAR_LIMIT
    ? fullText.substring(0, PREVIEW_CHAR_LIMIT) + '...'
    : fullText;

  return (
    <div className="flex flex-col gap-1">
      {/* Collapsible header with width-based preview (only when collapsed) - clean, no background */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={cn(
          "flex items-center gap-2 px-2 py-1.5 text-[13px]",
          "text-left w-full cursor-pointer",
          "transition-opacity duration-200 hover:opacity-80"
        )}
      >
        <ChevronRight
          className={cn(
            "w-3 h-3 text-muted-foreground/50 transition-transform duration-200 flex-shrink-0",
            isExpanded && "rotate-90"
          )}
        />
        <Brain className="w-4 h-4 text-purple-600/70 flex-shrink-0" />
        <span className="font-medium">Thinking</span>
        {!isExpanded && (
          <span className="text-muted-foreground italic truncate text-[12px]">
            {preview}
          </span>
        )}
      </button>

      {/* Expanded: show FULL thinking text */}
      {isExpanded && (
        <div className="ml-5 mt-1 text-[13px] text-muted-foreground whitespace-pre-wrap leading-relaxed">
          {fullText}
        </div>
      )}
    </div>
  );
}

export function SimpleAssistantMessage({ contentBlocks, messageId }: SimpleAssistantMessageProps) {
  const { toolResultMap } = useSession();

  // Find the index of the last text block for proper weight
  const lastTextBlockIndex = [...contentBlocks].reverse().findIndex(
    (block) => typeof block === 'string' || (typeof block === 'object' && block?.type === 'text')
  );
  const actualLastTextBlockIndex = lastTextBlockIndex !== -1
    ? contentBlocks.length - 1 - lastTextBlockIndex
    : -1;

  return (
    <div className="flex flex-col gap-2">
      {contentBlocks.map((block, index) => {
        // String blocks - render as text with markdown
        if (typeof block === 'string') {
          const isLastTextBlock = index === actualLastTextBlockIndex;
          return (
            <TextBlock
              key={`${messageId}:${index}`}
              block={block}
              role="assistant"
              weight={isLastTextBlock ? 'normal' : 'muted'}
            />
          );
        }

        // Text blocks - render with markdown
        if (block.type === 'text') {
          const textBlock = block as TextBlockType;
          const isLastTextBlock = index === actualLastTextBlockIndex;
          return (
            <TextBlock
              key={`${messageId}:${index}`}
              block={textBlock}
              role="assistant"
              weight={isLastTextBlock ? 'normal' : 'muted'}
            />
          );
        }

        // Tool use blocks - render as collapsible preview cards
        if (block.type === 'tool_use') {
          const toolBlock = block as ToolUseBlock;
          const toolResult = toolResultMap.get(toolBlock.id);

          return (
            <ToolPreviewCard
              key={`${messageId}:${index}`}
              toolBlock={toolBlock}
              toolResult={toolResult}
            />
          );
        }

        // Thinking blocks - render as expandable cards
        if (block.type === 'thinking') {
          const thinkingBlock = block as ThinkingBlockType;
          return (
            <ThinkingCard
              key={`${messageId}:${index}`}
              thinkingBlock={thinkingBlock}
            />
          );
        }

        return null;
      })}
    </div>
  );
}
