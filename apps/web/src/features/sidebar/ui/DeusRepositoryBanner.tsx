import { GitPullRequest } from "lucide-react";
import { cn } from "@/shared/lib/utils";

interface DeusRepositoryBannerProps {
  onNewWorkspace: () => void;
  className?: string;
}

/**
 * DeusRepositoryBanner — ambient contribution surface for the deus repo.
 *
 * Direction: "Quiet Recognition"
 * Philosophy: The tool knows it is being built. No announcement needed —
 * just a single textural note that makes the context tangible.
 *
 * Design: Icon aligns with repo avatar and plus-sign icon via the same
 * 20x20 icon slot used by SidebarRow. No left border, no card, no
 * background — just an aligned row that reads like a natural sidebar item.
 */
export function DeusRepositoryBanner({ onNewWorkspace, className }: DeusRepositoryBannerProps) {
  return (
    <div
      className={cn(
        // Match SidebarRow padding so icon aligns with repo avatar & plus icon
        "mt-0.5 mb-1.5 px-3 py-1",
        className
      )}
    >
      <div className="flex items-center gap-2">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center">
          <GitPullRequest className="text-primary/40 h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
        </span>
        <p className="text-2xs text-text-muted leading-[1.45]">
          This is the tool you&apos;re using.{" "}
          <button
            type="button"
            onClick={onNewWorkspace}
            className={cn(
              "text-text-tertiary",
              "decoration-border-default underline underline-offset-[2px]",
              "ease transition-colors duration-200",
              "hover:text-text-secondary hover:decoration-border-strong",
              // Invisible touch-padding so tap target is comfortable
              "-mx-0.5 px-0.5"
            )}
          >
            Shape it.
          </button>
        </p>
      </div>
    </div>
  );
}
