import type { ReactNode } from "react";
import { Check, X, Loader2 } from "lucide-react";
import { cn } from "@/shared/lib/utils";

interface CliStatusRowProps {
  name: string;
  description: string;
  installed: boolean | null; // null = loading
  detail?: string;
  actionLabel?: string;
  actionUrl?: string;
  actionIcon?: ReactNode;
  actionBusy?: boolean;
  actionDisabled?: boolean;
  onAction?: () => void;
  onRetry?: () => void;
  retryLabel?: string;
  showRetry?: boolean;
  retryWhenUnavailable?: boolean;
}

export function CliStatusRow({
  name,
  description,
  installed,
  detail,
  actionLabel,
  actionUrl,
  actionIcon,
  actionBusy = false,
  actionDisabled = false,
  onAction,
  onRetry,
  retryLabel = "Retry",
  showRetry = false,
  retryWhenUnavailable = true,
}: CliStatusRowProps) {
  const shouldShowRetry = !!onRetry && (showRetry || (retryWhenUnavailable && installed === false));

  return (
    <div className="bg-onboarding-foreground/5 flex items-center gap-4 rounded-xl px-4 py-3">
      <div
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
          installed === null
            ? "bg-onboarding-foreground/10"
            : installed
              ? "bg-success/20"
              : "bg-onboarding-foreground/10"
        )}
      >
        {installed === null ? (
          <Loader2 className="text-onboarding-foreground/50 h-4 w-4 animate-spin" />
        ) : installed ? (
          <Check className="text-success h-4 w-4" />
        ) : (
          <X className="text-onboarding-foreground/40 h-4 w-4" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <p className="text-onboarding-foreground text-sm font-medium">{name}</p>
        <p className="text-onboarding-foreground/50 truncate text-xs">
          {installed === null ? (detail ?? "Checking...") : detail || description}
        </p>
      </div>

      {actionLabel && actionUrl && (
        <a
          href={actionUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="bg-onboarding-foreground/10 text-onboarding-foreground hover:bg-onboarding-foreground/20 shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors duration-200"
        >
          {actionLabel}
        </a>
      )}

      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          disabled={actionDisabled || actionBusy}
          className="control-interaction bg-onboarding-foreground text-onboarding-contrast hover:bg-onboarding-foreground/90 active:bg-onboarding-foreground/80 inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed"
        >
          {actionBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : actionIcon}
          {actionLabel}
        </button>
      )}

      {shouldShowRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="control-interaction bg-onboarding-foreground/10 text-onboarding-foreground/70 hover:bg-onboarding-foreground/20 hover:text-onboarding-foreground shrink-0 rounded-lg px-3 py-1.5 text-sm font-normal"
        >
          {retryLabel}
        </button>
      )}
    </div>
  );
}
