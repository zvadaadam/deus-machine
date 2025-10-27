/**
 * Simple Assistant Message
 *
 * Scannable list of tools with icons for visual hierarchy.
 * Shows all tools directly - no collapsing, just pure display.
 */

import type { ContentBlock, ToolUseBlock, TextBlock as TextBlockType, ThinkingBlock as ThinkingBlockType } from '@/shared/types';
import { BlockRenderer } from '../blocks';
import { useSession } from '../../context';
import { FileText, Pencil, Terminal, Search, FolderOpen, CheckSquare, Brain, Globe, ExternalLink, Zap } from 'lucide-react';

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

export function SimpleAssistantMessage({ contentBlocks, messageId }: SimpleAssistantMessageProps) {
  const { toolResultMap } = useSession();

  let toolIndex = 0;

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

        // Tool use - show with icon and preview
        if (block.type === 'tool_use') {
          toolIndex++;
          const currentIndex = toolIndex;
          const toolBlock = block as ToolUseBlock;
          const Icon = getToolIcon(toolBlock.name);
          const preview = getToolPreview(toolBlock, toolResultMap);

          return (
            <div key={`${messageId}:${index}`} className="flex flex-col gap-1">
              {/* Tool header - number + icon + name + preview */}
              <div className="flex items-center gap-2 text-[13px]">
                <span className="text-muted-foreground/60 font-mono">{currentIndex}.</span>
                <Icon className="w-4 h-4 text-muted-foreground/70 flex-shrink-0" />
                <span className="text-foreground font-medium">{toolBlock.name}</span>
                {preview && (
                  <span className="text-muted-foreground truncate">{preview}</span>
                )}
              </div>

              {/* Full tool content */}
              <div className="ml-7">
                <BlockRenderer
                  block={toolBlock}
                  index={index}
                  role="assistant"
                />
              </div>
            </div>
          );
        }

        // Thinking block
        if (block.type === 'thinking') {
          toolIndex++;
          const currentIndex = toolIndex;
          const thinkingBlock = block as ThinkingBlockType;
          const text = thinkingBlock.thinking || '';
          const firstLine = text.split('\n')[0];
          const preview = firstLine.length > 60 ? firstLine.substring(0, 60) + '...' : firstLine;

          return (
            <div key={`${messageId}:${index}`} className="flex flex-col gap-1">
              {/* Thinking header */}
              <div className="flex items-center gap-2 text-[13px]">
                <span className="text-muted-foreground/60 font-mono">{currentIndex}.</span>
                <Brain className="w-4 h-4 text-purple-600/70 flex-shrink-0" />
                <span className="text-foreground font-medium">Thinking</span>
                <span className="text-muted-foreground italic truncate">{preview}</span>
              </div>

              {/* Full thinking text */}
              <div className="ml-7 text-[13px] text-muted-foreground whitespace-pre-wrap">
                {text}
              </div>
            </div>
          );
        }

        return null;
      })}
    </div>
  );
}
