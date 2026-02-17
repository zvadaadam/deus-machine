/**
 * Collapsed Panel Strips — compressed panel representations.
 *
 * When a panel collapses to its 36px minimum, these strips render
 * in place of the full content. Like a book on a shelf, spine facing
 * out: icon communicates identity, rotated label provides context.
 *
 * CollapsedChatStrip: breathing pulse when agent is working.
 * CollapsedContentStrip: slot-machine roll animation on tab switch.
 */

import { AnimatePresence, motion } from "framer-motion";
import { MessageSquare, Code2, Settings2, Terminal, BookOpen, PenTool, Globe } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipKbd } from "@/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import type { RightSideTab } from "@/features/workspace/store";

/** Icon + label map for content strip — mirrors the sidecar tab icons */
const contentTabMeta: Record<RightSideTab, { icon: typeof Code2; label: string }> = {
  code: { icon: Code2, label: "Code" },
  config: { icon: Settings2, label: "Config" },
  terminal: { icon: Terminal, label: "Terminal" },
  notebook: { icon: BookOpen, label: "Notebook" },
  design: { icon: PenTool, label: "Design" },
  browser: { icon: Globe, label: "Browser" },
};

/**
 * Compressed Chat Strip — the chat panel in its most reduced state.
 *
 * Not a button that says "bring me back" — the panel itself, compressed.
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
          {/* Icon — identity, not action. Breathes when agent is working. */}
          <MessageSquare
            className={cn(
              "h-[14px] w-[14px] flex-shrink-0",
              isWorking
                ? "animate-[strip-breathe_2s_cubic-bezier(0.645,0.045,0.355,1)_infinite]"
                : "animate-[strip-settle_0.15s_0.12s_cubic-bezier(0.165,0.84,0.44,1)] [animation-fill-mode:backwards]"
            )}
          />
          {/* Rotated label — reads bottom-to-top like a book spine */}
          <span
            className={cn(
              "text-xs font-medium tracking-[0.05em] uppercase",
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
 * Compressed Content Strip — the right content panel in its most reduced state.
 *
 * Mirrors the chat strip pattern: icon + rotated label for the active tab.
 * Border on the left (content-facing) side. Tooltip shows keyboard shortcut.
 *
 * Uses Framer Motion AnimatePresence for smooth crossfade when the user
 * switches sidecar tabs while content is collapsed — icon and label transition
 * instead of hard-swapping.
 */
export function CollapsedContentStrip({
  activeTab,
  onExpand,
}: {
  activeTab: RightSideTab;
  onExpand: () => void;
}) {
  const { icon: Icon, label } = contentTabMeta[activeTab];
  return (
    <Tooltip delayDuration={400}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`Show ${label} panel`}
          onClick={onExpand}
          className={cn(
            "border-border-subtle flex h-full w-full cursor-pointer flex-col items-center gap-3 border-l pt-4",
            "text-text-muted hover:text-text-secondary",
            "transition-colors duration-200 ease",
          )}
        >
          {/* Slot-machine roll when switching tabs via sidecar (number-flow style).
           * Old content slides up + fades out, new content slides up from below.
           * Framer Motion y-transform is post-layout so writing-mode doesn't interfere. */}
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.18, ease: [0.165, 0.84, 0.44, 1] }}
              className="flex flex-col items-center gap-3"
            >
              <Icon className="h-[14px] w-[14px] flex-shrink-0" />
              <span
                className={cn(
                  "text-xs font-medium tracking-[0.05em] uppercase",
                  "[writing-mode:vertical-rl] rotate-180",
                )}
              >
                {label}
              </span>
            </motion.div>
          </AnimatePresence>
        </button>
      </TooltipTrigger>
      <TooltipContent side="left" sideOffset={6}>
        <div className="flex items-center gap-3">
          <span className="text-xs">Show {label}</span>
          <TooltipKbd>{"\u2318]"}</TooltipKbd>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
