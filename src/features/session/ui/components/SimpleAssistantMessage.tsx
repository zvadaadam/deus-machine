/**
 * Simple Assistant Message
 *
 * Displays tool calls as collapsible cards with icon + preview.
 * Click any tool card to expand and see full details.
 */

import { useState } from 'react';
import type { ContentBlock, ToolUseBlock, TextBlock as TextBlockType, ThinkingBlock as ThinkingBlockType } from '@/shared/types';
import { BlockRenderer } from '../blocks';
import { useSession } from '../../context';
import { FileText, Pencil, Terminal, Search, FolderOpen, CheckSquare, Brain, Globe, ExternalLink, Zap, ChevronRight } from 'lucide-react';
import { cn } from '@/shared/lib/utils';

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

// Get one-line preview for each tool
const getToolPreview = (block: ToolUseBlock, toolResultMap: Map<string, any>): string => {
  const toolName = block.name;
  const input = block.input as any;

  switch (toolName) {
    case 'Read':
      const readPath = input?.file_path || '';
      const fileName = readPath.split('/').pop() || readPath;
      const toolResult = toolResultMap.get(block.id);
      let lineCount = 0;
      if (Array.isArray(toolResult?.content) && toolResult.content[0]?.type === 'text') {
        const textContent = toolResult.content[0] as any;
        const text = textContent.text;
        if (typeof text === 'string') {
          lineCount = text.split('\n').length;
        }
      }
      return `${lineCount} lines ${fileName}`;

    case 'Edit':
      const editPath = input?.file_path || '';
      const editFileName = editPath.split('/').pop() || editPath;
      return editFileName;

    case 'Bash':
      const command = input?.command || '';
      const shortCmd = command.length > 50 ? command.substring(0, 50) + '...' : command;
      return shortCmd;

    case 'Grep':
    case 'Glob':
      const pattern = input?.pattern || '';
      return `"${pattern}"`;

    case 'TodoWrite':
      const todos = input?.todos || [];
      return `${todos.length} items`;

    case 'Thinking':
      return '';

    default:
      return '';
  }
};

// Collapsible Tool Card Component
function ToolCard({
  toolBlock,
  index,
  toolResultMap
}: {
  toolBlock: ToolUseBlock;
  index: number;
  toolResultMap: Map<string, any>;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const Icon = getToolIcon(toolBlock.name);
  const preview = getToolPreview(toolBlock, toolResultMap);

  return (
    <div className="flex flex-col gap-1">
      {/* Clickable tool preview card */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={cn(
          "flex items-center gap-2 px-2 py-1.5 rounded-md text-[13px]",
          "bg-muted/5 hover:bg-muted/10 transition-colors",
          "text-left w-full cursor-pointer"
        )}
      >
        <ChevronRight
          className={cn(
            "w-3 h-3 text-muted-foreground/50 transition-transform flex-shrink-0",
            isExpanded && "rotate-90"
          )}
        />
        <Icon className="w-4 h-4 text-muted-foreground/70 flex-shrink-0" />
        <span className="text-foreground font-medium">{toolBlock.name}</span>
        {preview && (
          <span className="text-muted-foreground truncate">{preview}</span>
        )}
      </button>

      {/* Expanded content */}
      {isExpanded && (
        <div className="ml-5 mt-1">
          <BlockRenderer
            block={toolBlock}
            index={index}
            role="assistant"
          />
        </div>
      )}
    </div>
  );
}

// Collapsible Thinking Card Component
function ThinkingCard({
  thinkingBlock,
  blockIndex
}: {
  thinkingBlock: ThinkingBlockType;
  blockIndex: number;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const text = thinkingBlock.thinking || '';
  const firstLine = text.split('\n')[0];
  const preview = firstLine.length > 60 ? firstLine.substring(0, 60) + '...' : firstLine;

  return (
    <div className="flex flex-col gap-1">
      {/* Clickable thinking preview card */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={cn(
          "flex items-center gap-2 px-2 py-1.5 rounded-md text-[13px]",
          "bg-muted/5 hover:bg-muted/10 transition-colors",
          "text-left w-full cursor-pointer"
        )}
      >
        <ChevronRight
          className={cn(
            "w-3 h-3 text-muted-foreground/50 transition-transform flex-shrink-0",
            isExpanded && "rotate-90"
          )}
        />
        <Brain className="w-4 h-4 text-purple-600/70 flex-shrink-0" />
        <span className="text-foreground font-medium">Thinking</span>
        <span className="text-muted-foreground italic truncate">{preview}</span>
      </button>

      {/* Expanded thinking text */}
      {isExpanded && (
        <div className="ml-5 mt-1 text-[13px] text-muted-foreground whitespace-pre-wrap">
          {text}
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
        // String or text block
        if (typeof block === 'string') {
          return (
            <div key={`${messageId}:${index}`} className="text-[15px] leading-relaxed">
              {block}
            </div>
          );
        }

        if (block.type === 'text') {
          const textBlock = block as TextBlockType;
          return (
            <div key={`${messageId}:${index}`} className="text-[15px] leading-relaxed">
              {textBlock.text}
            </div>
          );
        }

        // Tool use - show as collapsible card
        if (block.type === 'tool_use') {
          const toolBlock = block as ToolUseBlock;
          return (
            <ToolCard
              key={`${messageId}:${index}`}
              toolBlock={toolBlock}
              index={index}
              toolResultMap={toolResultMap}
            />
          );
        }

        // Thinking block - show as collapsible card
        if (block.type === 'thinking') {
          const thinkingBlock = block as ThinkingBlockType;
          return (
            <ThinkingCard
              key={`${messageId}:${index}`}
              thinkingBlock={thinkingBlock}
              blockIndex={index}
            />
          );
        }

        return null;
      })}
    </div>
  );
}
