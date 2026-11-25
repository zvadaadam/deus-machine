import { memo, useId, useState, type Ref } from "react";
import { ChevronRight } from "lucide-react";
import { AnimatePresence } from "framer-motion";
import { Collapse } from "@/components/ui/collapse";
import { cn } from "@/shared/lib/utils";
import type { Part } from "@shared/protocol-types";
import { useTranscriptFold } from "../lib/openChat";
import { PartBlock } from "./blocks/PartBlock";
import { activityLabel } from "./utils/activityLabel";

export function ActivityButton({
  label,
  buttonRef,
  controls,
  expanded,
  onToggle,
}: {
  label: string;
  buttonRef?: Ref<HTMLButtonElement>;
  controls: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onToggle}
      className="text-muted-foreground focus-visible:inset-ring-ring flex w-full cursor-pointer items-center gap-2 px-2 py-1.5 text-left text-sm opacity-80 transition-opacity hover:opacity-100 focus-visible:inset-ring-2 focus-visible:outline-none"
      aria-expanded={expanded}
      aria-controls={controls}
      aria-label={`${expanded ? "Collapse" : "Expand"} activity, ${label}`}
    >
      <ChevronRight
        className={cn("size-3.5 shrink-0 opacity-50 transition-[rotate]", expanded && "rotate-90")}
        aria-hidden="true"
      />
      <span className="truncate tabular-nums">{label}</span>
    </button>
  );
}

export const TurnStatsHeader = memo(function TurnStatsHeader({
  rowId,
  parts,
  streaming,
}: {
  rowId: string;
  parts: Part[];
  streaming: boolean;
}) {
  // A closed work row in saved history needs its presence handler only after the first opening.
  const [expanded, toggle] = useTranscriptFold(parts[0]?.sessionId, "activity", rowId);
  const [expandedOnMount] = useState(expanded);
  const id = useId();
  return (
    <>
      <ActivityButton
        controls={id}
        label={activityLabel(parts, streaming)}
        expanded={!!expanded}
        onToggle={toggle}
      />
      {expanded !== undefined && (
        <AnimatePresence initial={!expandedOnMount}>
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
      )}
    </>
  );
});
