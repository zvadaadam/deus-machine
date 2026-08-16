/**
 * Compaction divider — the one-line marker for a context compaction.
 *
 * Positional, not conversational: it sits between the turn it fired during
 * and that turn's successor, so a reload shows the same seam the live stream
 * did. Deliberately quiet — a rule with a label, not a message bubble.
 */

import { memo } from "react";
import { Archive, TriangleAlert } from "lucide-react";
import type { Compaction } from "../types";
import { compactionLabel, compactionTokenLabel } from "../lib/chatTimeline";
import { cn } from "@/shared/lib/utils";

export const CompactionChip = memo(function CompactionChip({
  compaction,
}: {
  compaction: Compaction;
}) {
  const failed = compaction.status === "failed";
  const label = compactionLabel(compaction);
  const tokens = compactionTokenLabel(compaction);
  const Icon = failed ? TriangleAlert : Archive;

  return (
    <div
      className="flex items-center gap-2 px-2 py-1"
      role="separator"
      aria-label={tokens ? `${label}, ${tokens}` : label}
    >
      <span className="bg-border/60 h-px flex-1" aria-hidden="true" />
      <span
        className={cn(
          "inline-flex items-center gap-1.5 text-xs",
          failed ? "text-warning/80" : "text-muted-foreground/70"
        )}
      >
        <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span className="font-medium">{label}</span>
        {tokens && (
          <span className="text-muted-foreground/50 font-mono tracking-tight tabular-nums">
            {tokens}
          </span>
        )}
      </span>
      <span className="bg-border/60 h-px flex-1" aria-hidden="true" />
    </div>
  );
});
