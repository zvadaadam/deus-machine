import { ArrowUpRight, GitMerge, GitPullRequest, GitPullRequestClosed } from "lucide-react";
import { toast } from "sonner";
import type { ProjectAgent, ProjectPullRequest } from "@shared/projects";
import { native } from "@/platform";
import { cn } from "@/shared/lib/utils";
import { getErrorMessage } from "@shared/lib/errors";

export function ProjectPullRequests({
  pullRequests,
  agents,
}: {
  pullRequests: ProjectPullRequest[];
  agents: ProjectAgent[];
}) {
  return (
    <section aria-labelledby="project-prs-heading">
      <h2 id="project-prs-heading" className="text-text-primary mb-3 text-sm font-medium">
        Pull requests <span className="text-text-tertiary font-normal">{pullRequests.length}</span>
      </h2>
      {!pullRequests.length && (
        <p className="text-text-tertiary text-xs leading-relaxed">
          Pull requests opened or reported by agents will appear here.
        </p>
      )}
      <div className="divide-border-subtle divide-y">
        {pullRequests.map((pr) => {
          const verified = pr.checkedAt !== null;
          const status = !verified
            ? "Reported link"
            : pr.state === "merged"
              ? "Merged"
              : pr.state === "closed"
                ? "Closed"
                : pr.isDraft
                  ? "Draft"
                  : pr.state === "open"
                    ? "Open"
                    : "Status unavailable";
          const Icon =
            pr.state === "merged" && verified
              ? GitMerge
              : pr.state === "closed" && verified
                ? GitPullRequestClosed
                : GitPullRequest;
          const authorNames = pr.agentIds
            .map((id) => agents.find((agent) => agent.id === id)?.title)
            .filter(Boolean)
            .join(", ");
          return (
            <button
              key={pr.id}
              type="button"
              className="control-interaction group flex w-full min-w-0 items-start gap-2 rounded-lg py-3 text-left"
              onClick={() =>
                void native.window
                  .openExternal(pr.url)
                  .catch((error) => toast.error(getErrorMessage(error)))
              }
            >
              <Icon
                className={cn(
                  "mt-0.5 size-3.5 shrink-0",
                  verified && pr.state === "merged"
                    ? "text-primary"
                    : verified && pr.state === "open"
                      ? "text-success"
                      : "text-text-tertiary"
                )}
              />
              <span className="min-w-0 flex-1">
                <span className="text-text-primary line-clamp-2 text-xs font-medium">
                  {pr.title || `${pr.repository} #${pr.number}`}
                </span>
                <span className="text-text-tertiary mt-1 block text-xs">
                  #{pr.number} · {status}
                  {verified && pr.hasConflicts
                    ? " · Conflicts"
                    : verified && pr.ciStatus === "failing"
                      ? " · Checks failing"
                      : verified && pr.ciStatus === "pending"
                        ? " · Checks pending"
                        : ""}
                </span>
                {authorNames && (
                  <span className="text-text-tertiary mt-1 block truncate text-xs">
                    {authorNames}
                  </span>
                )}
              </span>
              <ArrowUpRight className="text-text-tertiary mt-0.5 size-3 shrink-0 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
            </button>
          );
        })}
      </div>
    </section>
  );
}
