import { GitPullRequest } from "lucide-react";
import { cn } from "@/shared/lib/utils";

interface OpenDevsRepositoryBannerProps {
  onNewWorkspace: () => void;
  className?: string;
}

/**
 * OpenDevsRepositoryBanner — ambient contribution surface for the opendevs repo.
 *
 * Direction: "Quiet Recognition"
 * Philosophy: The tool knows it is being built. No announcement needed —
 * just a single textural note that makes the context tangible. The left
 * border is the whole signal; the words only confirm what it implies.
 *
 * Design decisions:
 *
 * 1. Left border as the sole distinguishing mark.
 *    A 2px primary/20 rule is the lightest possible structural accent that
 *    still registers. It reads "this is different" without reading "ad."
 *    No card, no background fill, no gradient — those would feel like a
 *    promoted result inside a list. A rule reads like a margin note.
 *
 * 2. Single prose sentence, no CTA button.
 *    "Shape it." is the call to action, embedded as an inline link inside
 *    a natural sentence. Buttons imply obligation; this implies invitation.
 *    Users who want to contribute notice it. Users who don't are unbothered.
 *
 * 3. Fits sidebar density contract (≤32px tall).
 *    mx-3 aligns flush with SidebarRow's px-3. The natural height doesn't
 *    disrupt the visual rhythm of the workspace list immediately below.
 *
 * Tradeoff: the inline "Shape it." CTA is easy to scan past. This is
 * intentional — it respects users who aren't interested. Discovery is
 * ambient, not demanded.
 */
export function OpenDevsRepositoryBanner({
  onNewWorkspace,
  className,
}: OpenDevsRepositoryBannerProps) {
  return (
    <div
      className={cn(
        // Flush with SidebarRow horizontal padding
        "mx-3 mb-1.5 mt-0.5",
        // Left-border rule — the entire visual treatment
        "border-l-2 border-primary/20 pl-2.5 py-1",
        className
      )}
    >
      <div className="flex items-center gap-1.5">
        <GitPullRequest
          className="h-3 w-3 shrink-0 text-primary/40"
          strokeWidth={1.75}
          aria-hidden
        />
        <p className="text-2xs leading-[1.45] text-text-muted">
          This is the tool you&apos;re using.{" "}
          <button
            type="button"
            onClick={onNewWorkspace}
            className={cn(
              "text-text-tertiary",
              "underline decoration-border-default underline-offset-[2px]",
              "transition-colors duration-200 ease",
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
