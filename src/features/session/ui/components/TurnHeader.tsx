/**
 * Turn Header Component
 *
 * Collapsible header showing summary of tools executed in a turn.
 * Displays: "▸ Read 3 files, Edited 2 files" when collapsed
 *
 * Design Specs:
 * - Font: 13px (body-sm) semibold
 * - Color: --foreground
 * - Background: --muted/20 (subtle)
 * - Padding: 8px (p-2)
 * - Border radius: rounded-lg
 * - Hover: bg-muted/40
 * - Transition: 200ms ease-out
 */

import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/shared/lib/utils';

interface TurnHeaderProps {
  summary: string;
  expanded: boolean;
  onToggle: () => void;
  toolCount: number;
}

export function TurnHeader({ summary, expanded, onToggle, toolCount }: TurnHeaderProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        'w-full flex items-center gap-2 p-2 rounded-lg',
        'bg-muted/20 hover:bg-muted/40',
        'text-[13px] font-semibold text-foreground',
        'transition-all duration-200 ease-[cubic-bezier(0.215,0.61,0.355,1)]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        'motion-reduce:transition-none'
      )}
      aria-expanded={expanded}
      aria-label={`${expanded ? 'Collapse' : 'Expand'} turn with ${toolCount} tool${toolCount === 1 ? '' : 's'}`}
    >
      {/* Chevron icon */}
      {expanded ? (
        <ChevronDown className="w-4 h-4 text-muted-foreground flex-shrink-0" aria-hidden="true" />
      ) : (
        <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" aria-hidden="true" />
      )}

      {/* Summary text */}
      <span className="flex-1 text-left truncate">
        {summary}
      </span>
    </button>
  );
}
