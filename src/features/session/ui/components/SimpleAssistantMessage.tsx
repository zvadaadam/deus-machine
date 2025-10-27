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
const getToolPreview = (toolBlock: ToolUseBlock, toolResult: any): { text: string; isPath?: boolean } => {
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

      // Calculate diff stats for Edit
      if (toolBlock.name === 'Edit' && input?.old_string && input?.new_string) {
        const oldLines = input.old_string.split('\n').length;
        const newLines = input.new_string.split('\n').length;
        const added = Math.max(0, newLines - oldLines);
        const removed = Math.max(0, oldLines - newLines);

        if (added > 0 || removed > 0) {
          return { text: `${fileName} • +${added} -${removed}`, isPath: true };
        }
      }

      return { text: fileName, isPath: true };
    }

    case 'Bash':
    case 'BashOutput': {
      const command = input?.command || '';
      // Show command but keep it readable
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

  // Handle different content formats
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
      {/* Collapsible header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={cn(
          "flex items-center gap-2 px-2 py-1.5 rounded-md text-[13px]",
          "bg-muted/5 hover:bg-muted/10 transition-colors duration-200",
          "text-left w-full cursor-pointer",
          isError && "bg-destructive/5"
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
        {preview.text && (
          <span className={cn(
            "truncate text-[12px]",
            preview.isPath ? "font-mono text-muted-foreground" : "text-muted-foreground"
          )}>
            {preview.text}
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

  // Extract first sentence for preview
  const getFirstSentence = (text: string): string => {
    const match = text.match(/^[^.!?]+[.!?]/);
    if (match) {
      const sentence = match[0].trim();
      return sentence.length > 80 ? sentence.substring(0, 80) + '...' : sentence;
    }
    // Fallback: use first 80 chars
    return text.length > 80 ? text.substring(0, 80) + '...' : text;
  };

  // Get text after first sentence for detail view
  const getDetailText = (text: string): string => {
    const match = text.match(/^[^.!?]+[.!?]\s*/);
    if (match) {
      return text.substring(match[0].length).trim();
    }
    return text;
  };

  const firstSentence = getFirstSentence(fullText);
  const detailText = getDetailText(fullText);

  return (
    <div className="flex flex-col gap-1">
      {/* Collapsible header with first sentence preview */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={cn(
          "flex items-center gap-2 px-2 py-1.5 rounded-md text-[13px]",
          "bg-purple-500/5 hover:bg-purple-500/10 transition-colors duration-200",
          "text-left w-full cursor-pointer"
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
        <span className="text-muted-foreground italic truncate text-[12px]">
          {firstSentence}
        </span>
      </button>

      {/* Expanded detail text (without repeating first sentence) */}
      {isExpanded && detailText && (
        <div className="ml-5 mt-1 text-[13px] text-muted-foreground whitespace-pre-wrap leading-relaxed">
          {detailText}
        </div>
      )}
    </div>
  );
}

export function SimpleAssistantMessage({ contentBlocks, messageId }: SimpleAssistantMessageProps) {
  const { toolResultMap } = useSession();

  return (
    <div className="flex flex-col gap-2">
      {contentBlocks.map((block, index) => {
        // String blocks - render as text with markdown
        if (typeof block === 'string') {
          return (
            <TextBlock
              key={`${messageId}:${index}`}
              block={block}
              role="assistant"
            />
          );
        }

        // Text blocks - render with markdown
        if (block.type === 'text') {
          const textBlock = block as TextBlockType;
          return (
            <TextBlock
              key={`${messageId}:${index}`}
              block={textBlock}
              role="assistant"
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
