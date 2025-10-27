/**
 * Simple Assistant Message
 *
 * Ultra-minimal design inspired by pure text interfaces.
 * No icons, no colors, no decoration - just facts.
 *
 * Design: List of tools + text blocks, click to expand
 */

import { useState } from 'react';
import type { ContentBlock, ToolUseBlock, TextBlock as TextBlockType, ThinkingBlock as ThinkingBlockType } from '@/shared/types';
import { BlockRenderer } from '../blocks';
import { useSession } from '../../context';
import { cn } from '@/shared/lib/utils';

interface SimpleAssistantMessageProps {
  contentBlocks: (ContentBlock | string)[];
  messageId: string;
}

export function SimpleAssistantMessage({ contentBlocks, messageId }: SimpleAssistantMessageProps) {
  const { toolResultMap } = useSession();
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());

  const toggleTool = (toolId: string) => {
    setExpandedTools(prev => {
      const next = new Set(prev);
      if (next.has(toolId)) {
        next.delete(toolId);
      } else {
        next.add(toolId);
      }
      return next;
    });
  };

  // Extract one-line preview for each tool
  const getToolPreview = (block: ToolUseBlock): string => {
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
        return `${toolName} ${lineCount} lines ${fileName}`;

      case 'Edit':
        const editPath = input?.file_path || '';
        const editFileName = editPath.split('/').pop() || editPath;
        // Try to get diff stats from result
        return `${toolName} ${editFileName}`;

      case 'Bash':
        const command = input?.command || '';
        const shortCmd = command.length > 40 ? command.substring(0, 40) + '...' : command;
        return `${toolName} ${shortCmd}`;

      case 'Grep':
      case 'Glob':
        const pattern = input?.pattern || '';
        return `${toolName} "${pattern}"`;

      case 'TodoWrite':
        const todos = input?.todos || [];
        return `${toolName} ${todos.length} items`;

      default:
        return toolName;
    }
  };

  const getThinkingPreview = (block: ThinkingBlockType): string => {
    const text = block.thinking || '';
    const firstLine = text.split('\n')[0];
    const preview = firstLine.length > 60 ? firstLine.substring(0, 60) + '...' : firstLine;
    return `Thinking ${preview}`;
  };

  let toolIndex = 0;

  return (
    <div className="flex flex-col gap-0">
      {contentBlocks.map((block, index) => {
        if (typeof block === 'string') {
          return (
            <div key={`${messageId}:${index}`} className="text-[15px] leading-relaxed py-2">
              {block}
            </div>
          );
        }

        if (block.type === 'text') {
          const textBlock = block as TextBlockType;
          return (
            <div key={`${messageId}:${index}`} className="text-[15px] leading-relaxed py-2">
              {textBlock.text}
            </div>
          );
        }

        if (block.type === 'tool_use') {
          toolIndex++;
          const currentIndex = toolIndex;
          const toolBlock = block as ToolUseBlock;
          const isExpanded = expandedTools.has(toolBlock.id);
          const preview = getToolPreview(toolBlock);

          return (
            <div key={`${messageId}:${index}`} className="py-0.5">
              <button
                onClick={() => toggleTool(toolBlock.id)}
                className={cn(
                  'text-left w-full text-[13px] text-muted-foreground hover:text-foreground',
                  'transition-colors duration-150',
                  'font-mono'
                )}
              >
                {currentIndex}. {preview}
              </button>
              {isExpanded && (
                <div className="ml-4 mt-1 mb-2">
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

        if (block.type === 'thinking') {
          toolIndex++;
          const currentIndex = toolIndex;
          const thinkingBlock = block as ThinkingBlockType;
          const thinkingId = `thinking-${index}`;
          const isExpanded = expandedTools.has(thinkingId);
          const preview = getThinkingPreview(thinkingBlock);

          return (
            <div key={`${messageId}:${index}`} className="py-0.5">
              <button
                onClick={() => toggleTool(thinkingId)}
                className={cn(
                  'text-left w-full text-[13px] text-muted-foreground hover:text-foreground',
                  'transition-colors duration-150',
                  'font-mono italic'
                )}
              >
                {currentIndex}. {preview}
              </button>
              {isExpanded && (
                <div className="ml-4 mt-1 mb-2 text-[13px] text-muted-foreground whitespace-pre-wrap">
                  {thinkingBlock.thinking}
                </div>
              )}
            </div>
          );
        }

        return null;
      })}
    </div>
  );
}
