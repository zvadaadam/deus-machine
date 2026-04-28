import { FileCode2 } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { DiffCommentReference } from "../lib/parseDiffCommentTags";

interface DiffCommentPillProps {
  comment: DiffCommentReference;
}

export function DiffCommentPill({ comment }: DiffCommentPillProps) {
  const sideLabel = comment.side === "addition" ? "addition" : "deletion";
  const lineLabel = comment.line > 0 ? `:${comment.line}` : "";
  const label = comment.text.trim() || "Diff comment";

  return (
    <span className="inline min-w-0 align-baseline">
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="bg-primary/12 border-primary/20 text-foreground hover:bg-primary/16 inline-flex max-w-full cursor-help items-center gap-1 rounded-md border px-1.5 py-0.5 align-baseline text-xs leading-tight font-medium shadow-[inset_0_1px_0_color-mix(in_oklch,var(--background)_50%,transparent)] transition-colors duration-150">
              <FileCode2 className="text-primary inline-block h-3 w-3 shrink-0" />
              <span className="text-foreground/60 text-2xs shrink-0">Diff</span>
              <span className="truncate text-left">{label}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-sm">
            <div className="flex flex-col gap-1.5">
              <p className="text-2xs font-mono break-all">
                {comment.file}
                {lineLabel} ({sideLabel})
              </p>
              {comment.text && (
                <p className="text-muted-foreground text-xs whitespace-pre-wrap">{comment.text}</p>
              )}
            </div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </span>
  );
}
