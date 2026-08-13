import React from "react";
import { match } from "ts-pattern";
import {
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestArrow,
  GitPullRequestClosed,
  GitPullRequestDraft,
  TriangleAlert,
} from "lucide-react";

import { CircularPixelGrid } from "@/features/session/ui/CircularPixelGrid";
import type { Workspace } from "@/features/workspace/types";
import type { DisplayStatus } from "../lib/status";
import { WorkflowStatusIcon } from "./WorkflowStatusIcon";

/** Where the workspace is in its git journey — drives the icon glyph. */
export type GitLifecycle =
  | "merged"
  | "closed"
  | "conflicts"
  | "draft"
  | "changes_requested"
  | "open"
  | "linked"
  | "local"
  | "manual";

export function deriveGitLifecycle(workspace: Workspace): GitLifecycle {
  // Explicit user override (backlog/canceled) keeps its workflow glyph.
  if (workspace.status === "backlog" || workspace.status === "canceled") return "manual";
  if (workspace.pr_state === "merged") return "merged";
  if (workspace.pr_state === "closed") return "closed";
  if (workspace.pr_state === "open") {
    if (workspace.pr_has_conflicts) return "conflicts";
    if (workspace.pr_is_draft) return "draft";
    if (workspace.pr_review_status === "changes_requested") return "changes_requested";
    return "open";
  }
  // PR-picker workspaces know their pr_url before the first successful
  // lifecycle refresh — show a PR shape (muted) rather than a local branch.
  if (workspace.pr_url) return "linked";
  return "local";
}

interface WorkspaceGitIconProps {
  workspace: Workspace;
  displayStatus: DisplayStatus;
  size?: number;
}

/**
 * Workspace state icon. One glyph, two meanings:
 *  - shape = git/PR lifecycle (branch → draft → PR → merged/closed)
 *  - color = attention first (error red, unread gold), lifecycle otherwise
 *    (GitHub semantics: open green, merged purple, closed red).
 * A working or initializing agent replaces the glyph with the live pixel grid.
 */
export const WorkspaceGitIcon = React.memo(function WorkspaceGitIcon({
  workspace,
  displayStatus,
  size = 14,
}: WorkspaceGitIconProps) {
  if (workspace.state === "initializing" || displayStatus === "working") {
    return <CircularPixelGrid variant="working" size={size} resolution={8} />;
  }

  const lifecycle = deriveGitLifecycle(workspace);

  if (lifecycle === "manual") {
    return <WorkflowStatusIcon status={workspace.status} size={size} />;
  }

  // Attention overrides lifecycle color; the shape keeps telling the git story.
  const attentionClass = match(displayStatus)
    .with("error", () => "text-accent-red")
    .with("unread", () => "text-accent-gold")
    .otherwise(() => null);

  const Glyph = match(lifecycle)
    .with("merged", () => GitMerge)
    .with("closed", () => GitPullRequestClosed)
    .with("conflicts", () => TriangleAlert)
    .with("draft", () => GitPullRequestDraft)
    .with("changes_requested", () => GitPullRequestArrow)
    .with("open", () => GitPullRequest)
    .with("linked", () => GitPullRequest)
    .with("local", () => GitBranch)
    .exhaustive();

  const lifecycleClass = match(lifecycle)
    .with("merged", () => "text-status-in-review")
    .with("closed", () => "text-accent-red-muted")
    .with("conflicts", () => "text-accent-gold")
    .with("draft", () => "text-text-tertiary")
    .with("changes_requested", () => "text-accent-gold")
    .with("open", () => "text-accent-green")
    .with("linked", () => "text-text-muted")
    .with("local", () => "text-text-muted")
    .exhaustive();

  return <Glyph className={attentionClass ?? lifecycleClass} size={size} />;
});
