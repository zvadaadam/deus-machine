/**
 * Subagent Group Block
 *
 * Collapsible container for a single subagent (Task tool_use) that shows
 * the agent's internal work — tool calls, text, thinking — grouped together.
 *
 * Header: Cpu icon + description + subagent_type badge + tool count + status
 */

import { useState, useMemo } from "react";
import { ChevronRight, Cpu, Loader2 } from "lucide-react";
import NumberFlow from "@number-flow/react";
import { AnimatePresence, motion } from "framer-motion";
import { cn } from "@/shared/lib/utils";
import type { ToolUseBlock, ToolResultBlock } from "@/shared/types";

import { SubagentMessageList } from "./SubagentMessageList";
import { useSession, SessionProvider } from "../../context";

interface SubagentGroupBlockProps {
  toolUse: ToolUseBlock;
  toolResult?: ToolResultBlock;
  childMessages: Array<{ id: string; role: string; parts?: any[]; content?: string }>;
}

const expandTransition = { duration: 0.15, ease: [0.165, 0.84, 0.44, 1] as const };

export function SubagentGroupBlock({
  toolUse,
  toolResult,
  childMessages,
}: SubagentGroupBlockProps) {
  const { sessionStatus, subagentMessages } = useSession();
  const { description, subagent_type } = toolUse.input ?? {};

  const isRunning = sessionStatus === "working" && !toolResult;
  const isError = toolResult?.is_error;

  const [isExpanded, setIsExpanded] = useState(false);

  // Count TOOL parts across child messages
  const toolCount = useMemo(() => {
    let count = 0;
    childMessages.forEach((msg) => {
      if (msg.parts) {
        count += msg.parts.filter((p: any) => p.type === "TOOL").length;
      }
    });
    return count;
  }, [childMessages]);

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className={cn(
          "group flex items-center gap-2 px-2 py-1.5 text-sm",
          "w-full cursor-pointer text-left",
          "transition-opacity duration-150 ease-out",
          "opacity-80 hover:opacity-100",
          "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none"
        )}
        aria-expanded={isExpanded}
        aria-label={`${isExpanded ? "Collapse" : "Expand"} agent: ${description || "subagent"}`}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <div className="relative h-3.5 w-3.5 flex-shrink-0">
            {isRunning ? (
              <Loader2 className="text-muted-foreground/70 h-3.5 w-3.5 animate-spin" />
            ) : (
              <>
                <div
                  className={cn(
                    "absolute top-0 left-0 transition-opacity duration-150 ease-out",
                    isExpanded ? "opacity-0" : "opacity-100 group-hover:opacity-0"
                  )}
                >
                  <Cpu className="text-muted-foreground/70 h-3.5 w-3.5" />
                </div>
                <ChevronRight
                  className={cn(
                    "text-muted-foreground/50 absolute top-0 left-0 h-3.5 w-3.5 transition-[transform,opacity] duration-150 ease-out",
                    isExpanded && "rotate-90",
                    isExpanded ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                  )}
                  aria-hidden="true"
                />
              </>
            )}
          </div>

          <span className="text-muted-foreground truncate font-medium">
            {description || "Agent"}
          </span>

          {subagent_type && (
            <span className="bg-muted text-muted-foreground/70 text-2xs flex-shrink-0 rounded-md px-1.5 py-0.5 font-mono leading-none">
              {subagent_type}
            </span>
          )}

          {!isExpanded && toolCount > 0 && (
            <>
              <span className="text-muted-foreground/30" aria-hidden="true">
                ·
              </span>
              <span className="text-muted-foreground truncate">
                <NumberFlow
                  value={toolCount}
                  suffix={toolCount !== 1 ? " tool calls" : " tool call"}
                />
              </span>
            </>
          )}

          {isError && <span className="text-destructive/70 font-normal">Error</span>}
        </div>
      </button>

      <AnimatePresence initial={false}>
        {isExpanded && childMessages.length > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={expandTransition}
            style={{ overflow: "hidden" }}
            className="mt-0.5 ml-6"
          >
            <SessionProvider
              sessionStatus={sessionStatus}
              subagentMessages={subagentMessages}
              insideSubagent={true}
            >
              <SubagentMessageList messages={childMessages} />
            </SessionProvider>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
