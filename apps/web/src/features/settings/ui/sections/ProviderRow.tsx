import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/shared/lib/utils";
export function StatusDot({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "ready" | "neutral" | "warn";
}) {
  return (
    <span className="text-text-secondary inline-flex shrink-0 items-center gap-1.5 text-xs whitespace-nowrap">
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 rounded-full",
          tone === "ready"
            ? "bg-accent-green"
            : tone === "warn"
              ? "bg-warning"
              : "bg-muted-foreground/50"
        )}
      />
      {children}
    </span>
  );
}
export function ProviderRow({
  icon,
  name,
  detail,
  status,
  action,
  disclosure,
}: {
  icon: ReactNode;
  name: ReactNode;
  detail?: ReactNode;
  status?: ReactNode;
  action?: ReactNode;
  disclosure?: { expanded: boolean; toggle: () => void };
}) {
  const content = (
    <>
      <span className="text-text-secondary grid size-7 shrink-0 place-items-center">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="text-foreground block text-sm font-medium break-words">{name}</span>
        {detail && <span className="text-text-secondary block text-xs break-words">{detail}</span>}
      </span>
      {status}
    </>
  );
  return (
    <div
      data-provider-row=""
      className={cn("flex min-w-0 items-center gap-2.5", disclosure ? "px-1 py-2" : "py-3")}
    >
      {disclosure ? (
        <button
          type="button"
          aria-expanded={disclosure.expanded}
          onClick={disclosure.toggle}
          className="control-interaction flex min-w-0 flex-1 items-center gap-2.5 rounded-md text-left"
        >
          {content}
          <ChevronRight
            className={cn("text-text-muted size-3.5 shrink-0", disclosure.expanded && "rotate-90")}
          />
        </button>
      ) : (
        content
      )}
      {action}
    </div>
  );
}
