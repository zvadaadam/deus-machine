import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Fragment, memo, useMemo, type ReactNode } from "react";
import { CopyIcon } from "@/components/ui/copy-icon";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useCopyToClipboard } from "@/shared/hooks";
import { cn } from "@/shared/lib/utils";
import { formatTurnDurationLabel } from "./utils/formatTurnDurationLabel";
import type { TurnFooterData } from "./utils";

/** Progress and the settled footer exchange their content in one measured row. */
export function TurnFooterSlot({ children }: { children: ReactNode }) {
  return <div className="turn-footer-slot flex h-9 shrink-0 items-center">{children}</div>;
}

export const TurnFooter = memo(function TurnFooter({
  copyText,
  startedAt: startMs,
  durationMs,
  tokens,
  cost,
  attribution,
  workedTime,
}: TurnFooterData & { workedTime: string | null }) {
  const { copy, copied } = useCopyToClipboard({ resetDelay: 1600 });

  // Billed tokens = non-cached input + cache reads/writes + output (the three
  // input buckets are disjoint by protocol invariant, so this never double-counts).
  const tokenLabel = useMemo(() => {
    if (!tokens) return null;
    const total =
      tokens.input + tokens.output + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0);
    return total > 0 ? formatTokenCount(total) : null;
  }, [tokens]);

  const timestampTooltip = useMemo(() => {
    if (durationMs == null || startMs == null) return null;

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
  }, [durationMs, startMs]);

  const costLabel =
    cost != null && cost > 0 ? `$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}` : null;

  if (!copyText && durationMs == null && !tokenLabel && !costLabel && !attribution) return null;

  const execution = attribution?.execution;
  const metrics = [
    execution?.via && (
      <span key="provider" className="text-text-secondary truncate">
        {execution.modelLabel ?? execution.model} via {execution.via}
      </span>
    ),
    !workedTime &&
      durationMs != null &&
      (timestampTooltip ? (
        <TooltipProvider key="duration" delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                tabIndex={0}
                className="hover:bg-foreground/5 focus-visible:ring-ring inline-flex cursor-help rounded-sm px-1 font-mono tracking-tight tabular-nums transition-colors focus-visible:ring-2 focus-visible:outline-none"
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
        <span key="duration" className="font-mono tracking-tight tabular-nums">
          {formatTurnDurationLabel(durationMs)}
        </span>
      )),
    !workedTime && tokenLabel && (
      <span
        key="tokens"
        className="font-mono tracking-tight tabular-nums"
        title="Harness-reported tokens for this turn"
      >
        {tokenLabel}
      </span>
    ),
    !workedTime && costLabel && (
      <span
        key="cost"
        className="font-mono tracking-tight tabular-nums"
        title="Harness-reported cost for this turn"
      >
        {costLabel}
      </span>
    ),
  ].filter((metric) => !!metric);

  return (
    <div className="text-muted-foreground/70 flex items-center gap-1 px-2 py-1 text-xs">
      {metrics.map((metric, index) => (
        <Fragment key={metric.key}>
          {index > 0 && (
            <span className="text-muted-foreground/30" aria-hidden="true">
              •
            </span>
          )}
          {metric}
        </Fragment>
      ))}
      {(attribution || workedTime) && (
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="View turn details"
              className="control-interaction hover:bg-foreground/5 hover:text-foreground cursor-pointer rounded-lg px-1.5 py-0.5"
            >
              Details
            </button>
          </PopoverTrigger>
          <PopoverContent
            aria-label="Turn details"
            side="top"
            align="start"
            className="w-80 p-3 text-xs"
          >
            <p className="text-foreground mb-3 font-medium">Turn details</p>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
              {workedTime &&
                Object.entries({
                  Duration: workedTime,
                  Started: timestampTooltip?.startedLabel,
                  Finished: timestampTooltip?.endedLabel,
                  Tokens: tokenLabel,
                  Cost: costLabel,
                }).map(
                  ([label, value]) =>
                    value && (
                      <Fragment key={label}>
                        <dt className="text-muted-foreground">{label}</dt>
                        <dd className="font-mono tabular-nums">{value}</dd>
                      </Fragment>
                    )
                )}
              {attribution?.execution && (
                <>
                  <dt className="text-muted-foreground">Harness</dt>
                  <dd className="break-words">{attribution.execution.harness}</dd>
                  <dt className="text-muted-foreground">Selected model</dt>
                  <dd className="break-words">
                    {attribution.execution.model ?? "Harness default"}
                  </dd>
                  <dt className="text-muted-foreground">Thinking</dt>
                  <dd>{attribution.execution.thinkingLevel ?? "Harness default"}</dd>
                  {!!attribution.execution.reportedModels?.length && (
                    <>
                      <dt className="text-muted-foreground">Reported model</dt>
                      <dd className="break-words">
                        {attribution.execution.reportedModels.join(", ")}
                      </dd>
                    </>
                  )}
                </>
              )}
              {attribution && (
                <>
                  <dt className="text-muted-foreground">AI account</dt>
                  <dd className="break-words">
                    {attribution.providerCredentialSource?.account?.label ??
                      (attribution.providerCredentialSource?.source === "sdk_api_key"
                        ? "SDK-supplied API key"
                        : attribution.providerCredentialSource
                          ? "Personal account"
                          : "—")}
                  </dd>
                </>
              )}
              {attribution?.providerCredentialSource && (
                <>
                  <dt className="text-muted-foreground">Provider</dt>
                  <dd>{attribution.providerCredentialSource.provider}</dd>
                  <dt className="text-muted-foreground">Access</dt>
                  <dd>
                    {attribution.providerCredentialSource.authMethod === "subscription"
                      ? "Subscription"
                      : "API key"}
                  </dd>
                </>
              )}
              {attribution?.providerCredentialSource?.account && (
                <>
                  <dt className="text-muted-foreground">Account ID</dt>
                  <dd className="font-mono text-[10px] break-all select-text">
                    {attribution.providerCredentialSource.account.id}
                  </dd>
                  <dt className="text-muted-foreground">Revision</dt>
                  <dd className="font-mono text-[10px] break-all select-text">
                    {attribution.providerCredentialSource.account.revision}
                  </dd>
                </>
              )}
            </dl>
          </PopoverContent>
        </Popover>
      )}

      {copyText && (
        <button
          type="button"
          onClick={() => void copy(copyText)}
          className={cn(
            "control-interaction hover:bg-foreground/5 inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded-lg",
            copied
              ? "text-success hover:bg-success/10 hover:text-success"
              : "text-muted-foreground/55 hover:text-foreground"
          )}
          aria-label={copied ? "Copied response" : "Copy response"}
          title={copied ? "Copied" : "Copy response"}
        >
          <CopyIcon copied={copied} className="size-3" />
        </button>
      )}
    </div>
  );
});

/** 1234 → "1.2k", 1_234_567 → "1.2M" — the footer is a glance, not a ledger. */
function formatTokenCount(total: number): string {
  if (total < 1_000) return `${total} tok`;
  if (total < 1_000_000) return `${(total / 1_000).toFixed(1)}k tok`;
  return `${(total / 1_000_000).toFixed(1)}M tok`;
}
