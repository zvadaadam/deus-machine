/**
 * Assistant Turn Component - Redesigned for Scannability
 *
 * Displays assistant's work as a scannable timeline of actions + text.
 *
 * NEW Design Paradigm:
 * - Tool calls render as compact preview cards (icon + verb + preview)
 * - Text blocks have semantic weight (muted transitional, hero summary)
 * - Previous turns collapse to show only summary + action count
 * - Latest turn shows all actions expanded
 *
 * Design reference: CHAT_REDESIGN.md
 */

import { useState, useMemo } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { ContentBlock, ToolUseBlock, TextBlock as TextBlockType, ThinkingBlock as ThinkingBlockType } from '@/shared/types';
import { ToolPreview } from './ToolPreview';
import { ThinkingPreview } from './ThinkingPreview';
import { TextBlock, type TextWeight } from '../blocks/TextBlock';
import { getToolPreviewData } from '../utils/toolPreviewExtractors';
import { useSession } from '../../context';
import { cn } from '@/shared/lib/utils';

// Import existing tool renderers for full content
import { ToolUseBlock as ToolUseBlockRenderer } from '../blocks/ToolUseBlock';

interface AssistantTurnProps {
  contentBlocks: (ContentBlock | string)[];
  messageId: string;
  isLatest: boolean;
}

interface ProcessedBlock {
  type: 'tool' | 'text' | 'thinking';
  index: number;
  data: any;
}

export function AssistantTurn({ contentBlocks, messageId, isLatest }: AssistantTurnProps) {
  const { toolResultMap } = useSession();
  // All turns collapsed by default - let user expand what they need
  const [isExpanded, setIsExpanded] = useState(false);

  // Process blocks in order, maintaining chronological sequence
  const { processedBlocks, toolCount, finalSummary } = useMemo(() => {
    const blocks: ProcessedBlock[] = [];
    let tools = 0;
    let lastTextBlock: TextBlockType | null = null;

    contentBlocks.forEach((block, index) => {
      if (typeof block === 'object') {
        if (block.type === 'tool_use') {
          blocks.push({ type: 'tool', index, data: block as ToolUseBlock });
          tools++;
        } else if (block.type === 'text') {
          blocks.push({ type: 'text', index, data: block as TextBlockType });
          lastTextBlock = block as TextBlockType;
        } else if (block.type === 'thinking') {
          blocks.push({ type: 'thinking', index, data: block as ThinkingBlockType });
        }
      } else if (typeof block === 'string') {
        const textBlock: TextBlockType = { type: 'text', text: block };
        blocks.push({ type: 'text', index, data: textBlock });
        lastTextBlock = textBlock;
      }
    });

    return {
      processedBlocks: blocks,
      toolCount: tools,
      finalSummary: lastTextBlock,
    };
  }, [contentBlocks]);

  // Detect text weight based on position
  const getTextWeight = (block: ProcessedBlock, blockIndex: number): TextWeight => {
    // Last text block = hero
    if (block.data === finalSummary) {
      return 'hero';
    }

    // Text between tools = muted
    const prevBlock = processedBlocks[blockIndex - 1];
    const nextBlock = processedBlocks[blockIndex + 1];

    if (
      (prevBlock?.type === 'tool' || prevBlock?.type === 'thinking') &&
      (nextBlock?.type === 'tool' || nextBlock?.type === 'thinking')
    ) {
      return 'muted';
    }

    // Otherwise normal
    return 'normal';
  };

  // If no tools/thinking, render as simple message
  if (toolCount === 0 && !processedBlocks.some(b => b.type === 'thinking')) {
    return (
      <div className="flex flex-col gap-2">
        {processedBlocks.map((block, idx) => (
          <TextBlock
            key={`${messageId}:${block.index}`}
            block={block.data}
            role="assistant"
            weight="normal"
          />
        ))}
      </div>
    );
  }

  // COLLAPSED STATE (all turns with tools)
  if (!isExpanded) {
    return (
      <div className="flex flex-col">
        {/* Collapsed Header - inline, minimal */}
        <button
          onClick={() => setIsExpanded(true)}
          className={cn(
            'flex items-center gap-2 px-3 py-2',
            'rounded-md border border-border/20',
            'bg-transparent hover:bg-muted/20',
            'transition-all duration-150',
            'text-left w-full'
          )}
        >
          <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
          <span className="text-[13px] text-muted-foreground">
            {toolCount} {toolCount === 1 ? 'action' : 'actions'}
          </span>
        </button>

        {/* Show only final summary */}
        {finalSummary && (
          <div className="mt-2">
            <TextBlock
              block={finalSummary}
              role="assistant"
              weight="hero"
            />
          </div>
        )}
      </div>
    );
  }

  // EXPANDED STATE (show all content)
  return (
    <div className="flex flex-col gap-1">
      {/* Collapse button */}
      {toolCount > 0 && (
        <button
          onClick={() => setIsExpanded(false)}
          className={cn(
            'flex items-center gap-2 px-2 py-1',
            'rounded-md',
            'text-[12px] text-muted-foreground hover:text-foreground',
            'transition-colors duration-150',
            'self-start',
            '-mb-1'
          )}
        >
          <ChevronDown className="w-3 h-3" />
          <span>Hide actions</span>
        </button>
      )}

      {/* Render blocks in chronological order */}
      {processedBlocks.map((block, blockIndex) => {
        const key = `${messageId}:${block.index}`;

        if (block.type === 'tool') {
          const toolUse = block.data as ToolUseBlock;
          const toolResult = toolResultMap.get(toolUse.id);
          const previewData = getToolPreviewData(toolUse, toolResult);

          return (
            <ToolPreview
              key={key}
              toolUse={toolUse}
              toolResult={toolResult}
              previewData={previewData}
              defaultExpanded={false}
              fullContent={
                <ToolUseBlockRenderer
                  block={toolUse}
                  toolResult={toolResult}
                />
              }
            />
          );
        }

        if (block.type === 'thinking') {
          const thinkingBlock = block.data as ThinkingBlockType;
          return (
            <ThinkingPreview
              key={key}
              block={thinkingBlock}
              defaultExpanded={false}
            />
          );
        }

        if (block.type === 'text') {
          const textBlock = block.data as TextBlockType;
          const weight = getTextWeight(block, blockIndex);

          return (
            <TextBlock
              key={key}
              block={textBlock}
              role="assistant"
              weight={weight}
            />
          );
        }

        return null;
      })}
    </div>
  );
}
