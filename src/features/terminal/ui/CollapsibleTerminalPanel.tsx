import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/shared/lib/utils";
import { TerminalPanel } from "./TerminalPanel";

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
    // Expanded: Full terminal (collapse button integrated into TerminalPanel header)
    <div
      className="border-border flex flex-col overflow-hidden border-t-2 transition-[height] duration-300 ease-out"
      style={{ height: `${defaultHeight}px` }}
    >
      <TerminalPanel
        workspacePath={workspacePath}
        workspaceName={workspaceName}
        onCollapse={() => setIsExpanded(false)}
      />
    </div>
  ) : (
    // Collapsed: Terminal bar at bottom
    <div
      className="border-border hover:bg-muted/30 flex h-8 flex-shrink-0 cursor-pointer items-center justify-between border-t-2 px-3 transition-colors duration-200"
      onClick={() => setIsExpanded(true)}
      role="button"
      aria-label="Expand terminal"
      title="Click to expand terminal"
    >
      <span className="text-muted-foreground text-xs font-medium">Terminal</span>
      <ChevronUp className="text-muted-foreground h-3 w-3" />
    </div>
  );
}
