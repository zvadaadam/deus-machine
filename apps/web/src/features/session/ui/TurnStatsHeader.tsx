import { memo, useId, useState } from "react";
import { ChevronRight } from "lucide-react";
import { AnimatePresence } from "framer-motion";
import { Collapse } from "@/components/ui/collapse";
import { cn } from "@/shared/lib/utils";
import { toolCardName } from "@shared/mcp-servers";
import type { Part } from "@shared/protocol-types";
import { PartBlock } from "./blocks/PartBlock";
import { calculateTurnStats } from "./utils";

export const TurnStatsHeader = memo(function TurnStatsHeader({
  parts,
  streaming,
}: {
  parts: Part[];
  streaming: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const { toolCount, subagentCount, filesChanged } = calculateTurnStats(parts);
  let label = toolCount ? "Activity" : "Reasoning";
  if (streaming) {
    const active = parts.findLast(
      (part) =>
        (part.type === "reasoning" && part.state === "streaming") ||
        (part.type === "tool" &&
          (part.state.status === "pending" || part.state.status === "in_progress"))
    );
    if (active?.type === "tool")
      label =
        active.title ||
        (active.state.status === "in_progress" && active.state.title) ||
        toolCardName(active);
    else if (active?.type === "reasoning") label = "Thinking";
  }
  const metrics = [
    label,
    subagentCount && `${subagentCount} subagent${subagentCount === 1 ? "" : "s"}`,
    toolCount && `${toolCount} tool call${toolCount === 1 ? "" : "s"}`,
    !toolCount && parts.length > 1 && `${parts.length} steps`,
    filesChanged && `${filesChanged} file${filesChanged === 1 ? "" : "s"} changed`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="text-muted-foreground focus-visible:ring-ring flex w-full cursor-pointer items-center gap-2 px-2 py-1.5 text-left text-sm opacity-80 transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:outline-none"
        aria-expanded={expanded}
        aria-controls={id}
        aria-label={`${expanded ? "Collapse" : "Expand"} activity, ${metrics}`}
      >
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 opacity-50 transition-[rotate]",
            expanded && "rotate-90"
          )}
          aria-hidden="true"
        />
        <span className="truncate tabular-nums">{metrics}</span>
      </button>
      <AnimatePresence initial={false}>
        {expanded && (
          <Collapse
            id={id}
            className="border-border-subtle ml-3 flex min-w-0 flex-col gap-1 border-l pl-2"
          >
            {parts.map((part) => (
              <PartBlock key={part.id} part={part} isStreaming={streaming} />
            ))}
          </Collapse>
        )}
      </AnimatePresence>
    </>
  );
});
