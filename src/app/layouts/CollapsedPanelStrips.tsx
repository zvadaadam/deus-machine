/**
 * Collapsed Panel Strips -- compressed panel representations.
 *
 * When a panel collapses to its 36px minimum, these strips render in
 * place of the full content. Like a book on a shelf, spine facing out:
 * icon communicates identity, rotated label provides context.
 *
 * CollapsedChatStrip:    breathing pulse when agent is working.
 * CollapsedContentStrip: static strip for the content panel.
 */

import { MessageSquare, Code } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipKbd } from "@/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";

/**
 * Compressed Chat Strip -- the chat panel in its most reduced state.
 *
 * Not a button that says "bring me back" -- the panel itself, compressed.
 * Like a book on a shelf, spine facing out. Icon communicates identity,
 * rotated label provides context, breathing pulse signals active work.
 *
 * Width is controlled by the parent ResizablePanel's collapsedSize (36px).
 */
export function CollapsedChatStrip({
  onExpand,
  isWorking,
}: {
  onExpand: () => void;
  isWorking: boolean;
}) {
  return (
    <Tooltip delayDuration={400}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="Show chat panel"
          onClick={onExpand}
          className={cn(
            "border-border-subtle flex h-full w-full cursor-pointer flex-col items-center gap-3 border-r pt-4",
            "text-text-muted hover:text-text-secondary",
            "transition-colors duration-200 ease",
          )}
        >
          {/* Icon -- identity, not action. Breathes when agent is working. */}
          <MessageSquare
            className={cn(
              "h-[14px] w-[14px] flex-shrink-0",
              isWorking
                ? "animate-[strip-breathe_2s_cubic-bezier(0.645,0.045,0.355,1)_infinite]"
                : "animate-[strip-settle_0.15s_0.12s_cubic-bezier(0.165,0.84,0.44,1)] [animation-fill-mode:backwards]"
            )}
          />
          {/* Rotated label -- reads bottom-to-top like a book spine */}
          <span
            className={cn(
              "text-xs font-medium tracking-wide uppercase",
              "[writing-mode:vertical-rl] rotate-180",
              "animate-[strip-settle_0.15s_0.18s_cubic-bezier(0.165,0.84,0.44,1)] [animation-fill-mode:backwards]",
            )}
          >
            Chat
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={6}>
        <div className="flex items-center gap-3">
          <span className="text-xs">Show Chat</span>
          <TooltipKbd>{"\u2318\\"}</TooltipKbd>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Compressed Content Strip -- the content panel in its most reduced state.
 *
 * Mirrors CollapsedChatStrip's visual language but with a left border
 * (content panel sits on the right). No breathing animation -- the content
 * panel doesn't have a "working" state of its own.
 *
 * Width controlled by parent ResizablePanel's collapsedSize (36px).
 */
export function CollapsedContentStrip({
  onExpand,
}: {
  onExpand: () => void;
}) {
  return (
    <Tooltip delayDuration={400}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="Show content panel"
          onClick={onExpand}
          className={cn(
            "border-border-subtle flex h-full w-full cursor-pointer flex-col items-center gap-3 border-l pt-4",
            "text-text-muted hover:text-text-secondary",
            "transition-colors duration-200 ease",
          )}
        >
          {/* Icon -- identity, not action */}
          <Code
            className="animate-[strip-settle_0.15s_0.12s_cubic-bezier(0.165,0.84,0.44,1)] h-[14px] w-[14px] flex-shrink-0 [animation-fill-mode:backwards]"
          />
          {/* Rotated label -- reads bottom-to-top like a book spine */}
          <span
            className={cn(
              "text-xs font-medium tracking-wide uppercase",
              "[writing-mode:vertical-rl] rotate-180",
              "animate-[strip-settle_0.15s_0.18s_cubic-bezier(0.165,0.84,0.44,1)] [animation-fill-mode:backwards]",
            )}
          >
            Content
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="left" sideOffset={6}>
        <div className="flex items-center gap-3">
          <span className="text-xs">Show Content</span>
          <TooltipKbd>{"\u2318]"}</TooltipKbd>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
