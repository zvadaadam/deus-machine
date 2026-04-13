import { memo, useCallback, useMemo } from "react";
import { Check, Copy } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { Message } from "@/shared/types";
import { useCopyToClipboard } from "@/shared/hooks";
import { cn } from "@/shared/lib/utils";
import { formatTurnDurationLabel } from "./utils/formatTurnDurationLabel";
import { getTurnFooterData } from "./utils";

interface TurnFooterProps {
  messages: Message[];
  startedAt?: string | null;
}

export const TurnFooter = memo(function TurnFooter({ messages, startedAt }: TurnFooterProps) {
  const { copy, copied } = useCopyToClipboard({ resetDelay: 1600 });
  const { copyText, durationMs } = useMemo(
    () => getTurnFooterData(messages, startedAt),
    [messages, startedAt]
  );

  const handleCopy = useCallback(() => {
    if (!copyText) return;
    void copy(copyText);
  }, [copy, copyText]);

  const timestampTooltip = useMemo(() => {
    if (durationMs == null || !startedAt) return null;

    const startMs = Date.parse(startedAt);
    if (!Number.isFinite(startMs)) return null;

    const startDate = new Date(startMs);
    const endDate = new Date(startMs + durationMs);
    const formatter = new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    });

    return {
      startedLabel: formatter.format(startDate),
      endedLabel: formatter.format(endDate),
    };
  }, [durationMs, startedAt]);

  if (!copyText && durationMs == null) return null;

  return (
    <div className="text-muted-foreground/70 flex items-center gap-1 px-2 py-1 text-xs">
      {durationMs != null &&
        (timestampTooltip ? (
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  tabIndex={0}
                  className="hover:bg-foreground/5 focus-visible:ring-ring inline-flex cursor-help rounded-sm px-1 font-mono tracking-tight tabular-nums transition-colors duration-150 ease-out focus-visible:ring-2 focus-visible:outline-none"
                  aria-label={`Turn took ${formatTurnDurationLabel(durationMs)}. Started ${timestampTooltip.startedLabel}. Finished ${timestampTooltip.endedLabel}.`}
                >
                  {formatTurnDurationLabel(durationMs)}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" className="px-2.5 py-1.5">
                <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1">
                  <span className="text-muted-foreground/70">Started</span>
                  <span className="font-mono tabular-nums">{timestampTooltip.startedLabel}</span>
                  <span className="text-muted-foreground/70">Finished</span>
                  <span className="font-mono tabular-nums">{timestampTooltip.endedLabel}</span>
                </div>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          <span className="font-mono tracking-tight tabular-nums">
            {formatTurnDurationLabel(durationMs)}
          </span>
        ))}

      {durationMs != null && copyText && (
        <span className="text-muted-foreground/30" aria-hidden="true">
          •
        </span>
      )}

      {copyText && (
        <button
          type="button"
          onClick={handleCopy}
          className={cn(
            "hover:bg-foreground/5 focus-visible:ring-ring inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded-md transition-[color,background-color] duration-150 ease-out focus-visible:ring-2 focus-visible:outline-none",
            copied
              ? "text-success hover:bg-success/10 hover:text-success"
              : "text-muted-foreground/55 hover:text-foreground"
          )}
          aria-label={copied ? "Copied response" : "Copy response"}
          title={copied ? "Copied" : "Copy response"}
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        </button>
      )}
    </div>
  );
});
