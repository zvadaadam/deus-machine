/**
 * Part Tool Group Block
 *
 * Collapsible container for consecutive read-only TOOL parts.
 * Same visual as the legacy ToolGroupBlock but works with Part objects directly.
 */

import { useState, useMemo, memo } from "react";
import { ChevronRight, Layers } from "lucide-react";
import { AnimatePresence, m } from "framer-motion";
import { cn } from "@/shared/lib/utils";
import type { ToolPart } from "@shared/messages/types";

import { ToolPartBlock } from "./ToolPartBlock";

interface PartToolGroupBlockProps {
  parts: ToolPart[];
  isSealed: boolean;
}

const expandTransition = { duration: 0.2, ease: [0.165, 0.84, 0.44, 1] as const };

export const PartToolGroupBlock = memo(function PartToolGroupBlock({
  parts,
  isSealed,
}: PartToolGroupBlockProps) {
  const showHeader = isSealed && parts.length >= 2;

  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);
  const isExpanded = manualExpanded !== null ? manualExpanded : !showHeader;
  const isOpen = showHeader ? isExpanded : true;

  const toolSummary = useMemo(() => {
    const names = new Set(parts.map((p) => p.toolName));
    return [...names].join(", ");
  }, [parts]);

  return (
    <div className="flex w-full min-w-0 flex-col" style={{ contain: "layout style" }}>
      {showHeader && (
        <div className="tool-group-header-enter">
          <button
            type="button"
            onClick={() => setManualExpanded(!isExpanded)}
            className={cn(
              "group flex items-center gap-2 px-2 py-1.5 text-sm",
              "w-full cursor-pointer text-left",
              "transition-opacity duration-150 ease-out",
              "opacity-80 hover:opacity-100",
              "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none"
            )}
            aria-expanded={isExpanded}
            aria-label={`${isExpanded ? "Collapse" : "Expand"} ${parts.length} tool calls`}
          >
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <div className="relative h-3.5 w-3.5 flex-shrink-0">
                <div
                  className={cn(
                    "absolute top-0 left-0 transition-opacity duration-150 ease-out",
                    isExpanded ? "opacity-0" : "opacity-100 group-hover:opacity-0"
                  )}
                >
                  <Layers className="text-muted-foreground/70 h-3.5 w-3.5" />
                </div>
                <ChevronRight
                  className={cn(
                    "text-muted-foreground/50 absolute top-0 left-0 h-3.5 w-3.5 transition-[transform,opacity] duration-150 ease-out",
                    isExpanded && "rotate-90",
                    isExpanded ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                  )}
                  aria-hidden="true"
                />
              </div>

              <span className="text-foreground/70 font-medium tabular-nums">
                {parts.length} tool call{parts.length !== 1 ? "s" : ""}
              </span>

              {toolSummary && (
                <>
                  <span className="text-muted-foreground/30" aria-hidden="true">
                    ·
                  </span>
                  <span className="text-muted-foreground truncate">{toolSummary}</span>
                </>
              )}
            </div>
          </button>
        </div>
      )}

      <AnimatePresence>
        {isOpen && (
          <m.div
            initial={showHeader ? { opacity: 0, height: 0 } : false}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={expandTransition}
            className="flex flex-col gap-0.5 overflow-hidden"
          >
            {parts.map((p) => (
              <ToolPartBlock key={p.id} part={p} />
            ))}
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
});
