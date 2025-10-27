/**
 * Assistant Turn Component
 *
 * Wraps an assistant's response with collapsible tool section + summary.
 *
 * Structure:
 * ┌─────────────────────────────────────┐
 * │ ▾ Read 3 files, Edited 2 files      │ ← TurnHeader (collapsible)
 * │                                     │
 * │ [Tool blocks when expanded]         │ ← Tool section
 * │ ─────────────────────────────────── │ ← TurnDivider
 * │ [Summary text - always visible]     │ ← Summary section
 * └─────────────────────────────────────┘
 *
 * Behavior:
 * - Latest turn: Expanded by default
 * - Previous turns: Collapsed by default
 * - User can manually toggle any turn
 * - When new user message sent, previous turn auto-collapses
 */

import { useState, useMemo } from 'react';
import type { ContentBlock, ToolUseBlock, TextBlock as TextBlockType } from '@/shared/types';
import { TurnHeader } from './TurnHeader';
import { TurnDivider } from './TurnDivider';
import { BlockRenderer } from '../blocks';
import { generateToolSummary } from '../utils/toolCategories';
import { cn } from '@/shared/lib/utils';

interface AssistantTurnProps {
  contentBlocks: (ContentBlock | string)[];
  messageId: string;
  isLatest: boolean;
}

export function AssistantTurn({ contentBlocks, messageId, isLatest }: AssistantTurnProps) {
  // Debug log
  if (import.meta.env.DEV) {
    console.log('[AssistantTurn] Rendering turn:', { messageId, isLatest, blockCount: contentBlocks.length });
  }

  // Expanded by default if latest turn
  const [isExpanded, setIsExpanded] = useState(isLatest);

  // Separate tool blocks from text blocks
  const { toolBlocks, textBlocks, hasThinking } = useMemo(() => {
    const tools: ToolUseBlock[] = [];
    const texts: TextBlockType[] = [];
    let thinking = false;

    contentBlocks.forEach(block => {
      if (typeof block === 'object') {
        if (block.type === 'tool_use') {
          tools.push(block as ToolUseBlock);
        } else if (block.type === 'text') {
          texts.push(block as TextBlockType);
        } else if (block.type === 'thinking') {
          thinking = true;
        }
      }
    });

    return {
      toolBlocks: tools,
      textBlocks: texts,
      hasThinking: thinking,
    };
  }, [contentBlocks]);

  // Generate summary text for header
  const toolSummary = useMemo(() => {
    return generateToolSummary(toolBlocks);
  }, [toolBlocks]);

  // If no tools, render as simple message (no turn header)
  if (toolBlocks.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        {contentBlocks.map((block, index) => {
          const key = typeof block === 'object' && block.type === 'tool_use'
            ? block.id
            : `${messageId}:${index}`;
          return (
            <BlockRenderer
              key={key}
              block={block}
              index={index}
              role="assistant"
            />
          );
        })}
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {/* Turn Header - Collapsible summary */}
      <TurnHeader
        summary={toolSummary}
        expanded={isExpanded}
        onToggle={() => setIsExpanded(!isExpanded)}
        toolCount={toolBlocks.length}
      />

      {/* Tool Section - Expandable */}
      <div
        className={cn(
          'overflow-hidden transition-all duration-200 ease-[cubic-bezier(0.215,0.61,0.355,1)]',
          'motion-reduce:transition-none',
          isExpanded
            ? 'max-h-[10000px] opacity-100 mt-2'
            : 'max-h-0 opacity-0 mt-0'
        )}
      >
        {/* Tool blocks */}
        <div className="flex flex-col gap-1">
          {toolBlocks.map((block, index) => (
            <BlockRenderer
              key={block.id}
              block={block}
              index={index}
              role="assistant"
            />
          ))}
        </div>

        {/* Divider between tools and summary (only if both exist) */}
        {textBlocks.length > 0 && <TurnDivider />}
      </div>

      {/* Summary Section - Always visible */}
      {textBlocks.length > 0 && (
        <div
          className={cn(
            'flex flex-col gap-2',
            // Add spacing when tools are collapsed (header exists)
            isExpanded ? 'mt-0' : 'mt-2',
            // Larger text and padding for summary (hero content)
            'text-[16px] leading-relaxed py-5'
          )}
        >
          {textBlocks.map((block, index) => (
            <BlockRenderer
              key={`text-${messageId}:${index}`}
              block={block}
              index={index}
              role="assistant"
            />
          ))}
        </div>
      )}

      {/* Render thinking blocks (if any) */}
      {hasThinking && contentBlocks.map((block, index) => {
        if (typeof block === 'object' && block.type === 'thinking') {
          return (
            <BlockRenderer
              key={`thinking-${messageId}:${index}`}
              block={block}
              index={index}
              role="assistant"
            />
          );
        }
        return null;
      })}
    </div>
  );
}
