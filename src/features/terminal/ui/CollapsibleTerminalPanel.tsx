import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/shared/lib/utils';
import { TerminalPanel } from './TerminalPanel';

interface CollapsibleTerminalPanelProps {
  workspacePath: string;
  workspaceName: string;
  defaultHeight?: number;
}

/**
 * CollapsibleTerminalPanel - Terminal with collapse/expand functionality
 *
 * Features:
 * - Expanded: Shows full terminal with collapse button (default 250px height)
 * - Collapsed: Shows 32px "Console" bar at bottom, click to expand
 * - Smooth transitions with ease-out animation
 */
export function CollapsibleTerminalPanel({
  workspacePath,
  workspaceName,
  defaultHeight = 250,
}: CollapsibleTerminalPanelProps) {
  const [isExpanded, setIsExpanded] = useState(true);

  return isExpanded ? (
    // Expanded: Full terminal with collapse button
    <div
      className="flex flex-col border-t-2 border-border transition-[height] duration-300 ease-out overflow-hidden"
      style={{ height: `${defaultHeight}px` }}
    >
      {/* Header with collapse button - minimal, no label needed */}
      <div className="flex items-center justify-end px-2 py-1 bg-background/50 backdrop-blur-sm border-b border-border/40 flex-shrink-0">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setIsExpanded(false)}
          className="h-6 w-6"
          title="Collapse terminal"
        >
          <ChevronDown className="h-3 w-3" />
        </Button>
      </div>

      {/* Terminal content */}
      <div className="flex-1 overflow-hidden">
        <TerminalPanel
          workspacePath={workspacePath}
          workspaceName={workspaceName}
        />
      </div>
    </div>
  ) : (
    // Collapsed: Terminal bar at bottom
    <div
      className="h-8 border-t-2 border-border flex items-center justify-between px-3 cursor-pointer hover:bg-muted/30 transition-colors duration-200 flex-shrink-0"
      onClick={() => setIsExpanded(true)}
      role="button"
      aria-label="Expand terminal"
      title="Click to expand terminal"
    >
      <span className="text-xs font-medium text-muted-foreground">Terminal</span>
      <ChevronUp className="h-3 w-3 text-muted-foreground" />
    </div>
  );
}
