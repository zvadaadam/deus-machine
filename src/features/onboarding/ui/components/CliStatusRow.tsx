import { Check, X, Loader2 } from "lucide-react";
import { cn } from "@/shared/lib/utils";

interface CliStatusRowProps {
  name: string;
  description: string;
  installed: boolean | null; // null = loading
  detail?: string;
  actionLabel?: string;
  actionUrl?: string;
  onRetry?: () => void;
}

export function CliStatusRow({
  name,
  description,
  installed,
  detail,
  actionLabel,
  actionUrl,
  onRetry,
}: CliStatusRowProps) {
  return (
    <div className="flex items-center gap-4 rounded-xl bg-white/5 px-4 py-3">
      <div
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
          installed === null ? "bg-white/10" : installed ? "bg-emerald-500/20" : "bg-white/10"
        )}
      >
        {installed === null ? (
          <Loader2 className="h-4 w-4 animate-spin text-white/50" />
        ) : installed ? (
          <Check className="h-4 w-4 text-emerald-400" />
        ) : (
          <X className="h-4 w-4 text-white/40" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-white">{name}</p>
        <p className="truncate text-xs text-white/50">
          {installed === null ? "Checking..." : detail || description}
        </p>
      </div>

      {installed === false && actionLabel && actionUrl && (
        <a
          href={actionUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 rounded-lg bg-white/10 px-3 py-1.5 text-xs font-medium text-white transition-colors duration-200 hover:bg-white/20"
        >
          {actionLabel}
        </a>
      )}

      {onRetry && installed === false && (
        <button
          onClick={onRetry}
          className="shrink-0 rounded-lg bg-white/10 px-3 py-1.5 text-xs font-medium text-white/70 transition-colors duration-200 hover:bg-white/20 hover:text-white"
        >
          Retry
        </button>
      )}
    </div>
  );
}
