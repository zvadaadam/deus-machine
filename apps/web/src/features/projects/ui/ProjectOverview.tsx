import { useState } from "react";
import { ArrowUpRight, Check, FileText, GitPullRequest, Layers, Square, Users } from "lucide-react";
import { toast } from "sonner";
import type { ProjectAgent, ProjectDetail } from "@shared/projects";
import type { DiffStats } from "@/shared/types";
import { Button } from "@/components/ui";
import { native } from "@/platform";
import { cn } from "@/shared/lib/utils";
import { getErrorMessage } from "@shared/lib/errors";
import { useProjectAction } from "../api/projects.queries";
import { type ProjectFileSelection } from "./ProjectFilePane";
import { ProjectPullRequests } from "./ProjectPullRequests";
import { ProjectMessageQueue } from "./ProjectMessageQueue";
import { ProjectMarkdown } from "./ProjectMarkdown";

export function ProjectOverview({
  project,
  activeAgentId = null,
  diffStats,
  onOpenAgent,
  onOpenChanges,
  onOpenFile,
}: {
  project: ProjectDetail;
  /** The agent whose conversation is showing; its row reads as selected. */
  activeAgentId?: string | null;
  /** Uncommitted line counts per agent workspace, when known. */
  diffStats?: Record<string, DiffStats>;
  onOpenAgent: (agent: ProjectAgent) => void;
  /** Open the agent's conversation with its Changes beside it. */
  onOpenChanges?: (agent: ProjectAgent) => void;
  onOpenFile: (file: ProjectFileSelection) => void;
}) {
  const action = useProjectAction(project.id);
  const [expandedReportId, setExpandedReportId] = useState<string | null>(null);
  const run = (input: Parameters<typeof action.mutate>[0]) =>
    action.mutate(input, {
      onError: (error) => toast.error(getErrorMessage(error)),
    });
  const canEdit = project.status !== "archived";
  // Before the first instruction there is a coordinator and nothing else worth
  // tracking; say so instead of showing three empty sections.
  const awaitingBrief =
    !project.brief.trim() && !project.reports.length && !project.pullRequests?.length;

  return (
    <div className="flex flex-col gap-7 p-5">
      {awaitingBrief && (
        <section
          aria-label="Nothing to track yet"
          className="flex flex-col items-center gap-2 px-4 pt-6 pb-2 text-center"
          data-slot="project-empty"
        >
          <span className="bg-bg-muted text-text-tertiary flex size-10 items-center justify-center rounded-lg">
            <Layers aria-hidden className="size-4" />
          </span>
          <h2 className="text-text-primary text-sm font-medium">Nothing to track yet</h2>
          <p className="text-text-tertiary max-w-xs text-xs leading-relaxed">
            Tell the coordinator what this project should accomplish. Its agents, results and pull
            requests appear here.
          </p>
        </section>
      )}
      <section aria-labelledby="project-agents-heading">
        <div className="mb-2 flex items-center justify-between">
          <h2
            id="project-agents-heading"
            className="text-text-primary flex items-center gap-2 text-sm font-medium"
          >
            <Users className="text-text-tertiary size-3.5" />
            Agents<span className="text-text-tertiary font-normal">{project.agents.length}</span>
          </h2>
          <span className="text-text-tertiary text-xs">{project.activeAgentCount} working</span>
        </div>
        <div className="divide-border-subtle divide-y">
          {project.agents.map((agent) => {
            const stats = diffStats?.[agent.workspaceId];
            const changed = Boolean(stats && (stats.additions > 0 || stats.deletions > 0));
            const selected = agent.id === activeAgentId;
            return (
              <div
                key={agent.id}
                className={cn(
                  "group -mx-2 flex items-start gap-2 rounded-lg px-2 py-3",
                  selected && "bg-control-hover"
                )}
                data-slot="project-agent-row"
                data-selected={selected || undefined}
              >
                <span
                  className={cn(
                    "mt-1.5 size-1.5 shrink-0 rounded-full",
                    agent.status === "working"
                      ? "bg-info"
                      : agent.status === "needs-attention"
                        ? "bg-warning"
                        : "bg-text-muted"
                  )}
                />
                <button
                  type="button"
                  aria-label={`Open ${agent.title}`}
                  aria-current={selected || undefined}
                  className="control-interaction min-w-0 flex-1 rounded-lg text-left"
                  onClick={() => onOpenAgent(agent)}
                >
                  <span className="text-text-primary flex items-center gap-1 text-sm font-medium">
                    {agent.title}
                  </span>
                  <span className="text-text-tertiary mt-0.5 block text-xs">
                    {agent.role === "coordinator" ? "Coordinator" : "Agent"} ·{" "}
                    {agent.status === "needs-attention"
                      ? "Needs attention"
                      : agent.status.charAt(0).toUpperCase() + agent.status.slice(1)}
                  </span>
                  <span
                    className={cn(
                      "mt-1.5 line-clamp-2 text-xs leading-relaxed",
                      agent.task ? "text-text-secondary" : "text-text-tertiary"
                    )}
                  >
                    {agent.task ||
                      (agent.role === "coordinator"
                        ? "Waiting for your first instruction"
                        : "No task recorded")}
                  </span>
                  {agent.error && (
                    <span className="text-destructive mt-1.5 block text-xs">{agent.error}</span>
                  )}
                </button>
                {changed && stats && (
                  <button
                    type="button"
                    aria-label={`${agent.title} changes: ${stats.additions} added, ${stats.deletions} removed`}
                    title="Show changes"
                    className="control-interaction hover:bg-control-hover mt-0.5 flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs font-medium tabular-nums"
                    onClick={() => (onOpenChanges ?? onOpenAgent)(agent)}
                  >
                    {stats.additions > 0 && (
                      <span className="text-accent-green">+{stats.additions}</span>
                    )}
                    {stats.deletions > 0 && (
                      <span className="text-accent-red">-{stats.deletions}</span>
                    )}
                  </button>
                )}
                {agent.status === "working" && canEdit && (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Stop ${agent.title}`}
                    disabled={action.isPending}
                    onClick={() =>
                      run({ action: "stop", agentId: agent.id, requestId: crypto.randomUUID() })
                    }
                  >
                    <Square className="size-3" />
                  </Button>
                )}
                {agent.canRetry &&
                agent.sessionId &&
                (agent.paused || agent.status === "needs-attention" || project.paused) &&
                canEdit ? (
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={action.isPending}
                    onClick={() =>
                      run({ action: "retry", agentId: agent.id, requestId: crypto.randomUUID() })
                    }
                  >
                    Continue
                  </Button>
                ) : (
                  agent.paused &&
                  !project.paused &&
                  canEdit && (
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={action.isPending}
                      onClick={() =>
                        run({
                          action: "resume-agent",
                          agentId: agent.id,
                          requestId: crypto.randomUUID(),
                        })
                      }
                    >
                      Resume
                    </Button>
                  )
                )}
                {agent.status === "needs-attention" && !agent.sessionId && canEdit && (
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={action.isPending}
                    onClick={() =>
                      run({ action: "retry", agentId: agent.id, requestId: crypto.randomUUID() })
                    }
                  >
                    Retry
                  </Button>
                )}
              </div>
            );
          })}
          {!project.agents.length && (
            <p className="text-text-tertiary py-3 text-xs leading-relaxed">
              Preparing the coordinator’s workspace…
            </p>
          )}
        </div>
      </section>

      <ProjectMessageQueue project={project} />
      {!awaitingBrief && (
        <ProjectPullRequests pullRequests={project.pullRequests ?? []} agents={project.agents} />
      )}

      {!awaitingBrief && (
        <section aria-labelledby="project-results-heading">
          <h2 id="project-results-heading" className="text-text-primary mb-3 text-sm font-medium">
            Results <span className="text-text-tertiary font-normal">{project.reports.length}</span>
          </h2>
          {!project.reports.length && (
            <p className="text-text-tertiary text-xs leading-relaxed">
              Completed work and submitted reports will appear here, with their files and pull
              requests.
            </p>
          )}
          <div className="flex flex-col gap-4">
            {project.reports.map((report) => (
              <article
                key={report.id}
                className="border-border-subtle rounded-lg border p-3.5"
                data-slot="project-result"
              >
                <div className="mb-2 flex items-center justify-between gap-2 text-xs">
                  <span className="text-text-secondary font-medium">{report.agentTitle}</span>
                  {report.accepted && (
                    <span className="text-success flex items-center gap-1">
                      <Check className="size-3" />
                      Accepted
                    </span>
                  )}
                </div>
                <div
                  className={cn(
                    report.summary.length > 500 &&
                      expandedReportId !== report.id &&
                      "max-h-40 overflow-hidden"
                  )}
                >
                  <ProjectMarkdown
                    className="text-sm"
                    sourcePath={`results/${report.assignmentId}/report.md`}
                    availablePaths={report.files.map((artifact) => artifact.path)}
                    onOpenFile={(path) =>
                      onOpenFile({
                        path,
                        revision: report.revision,
                        fromReport: true,
                        availablePaths: report.files.map((artifact) => artifact.path),
                      })
                    }
                  >
                    {report.summary}
                  </ProjectMarkdown>
                </div>
                {report.summary.length > 500 && (
                  <button
                    type="button"
                    className="control-interaction text-text-secondary hover:text-text-primary mt-2 rounded text-xs underline underline-offset-4"
                    aria-expanded={expandedReportId === report.id}
                    onClick={() =>
                      setExpandedReportId(expandedReportId === report.id ? null : report.id)
                    }
                  >
                    {expandedReportId === report.id ? "Show less" : "Read full report"}
                  </button>
                )}
                {(report.files.length > 0 || report.pullRequests.length > 0) && (
                  <div className="mt-3 flex flex-col gap-1">
                    {report.files.map((artifact) => (
                      <button
                        type="button"
                        key={artifact.path}
                        className="control-interaction text-text-secondary hover:bg-control-hover flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs"
                        title={artifact.path}
                        onClick={() =>
                          onOpenFile({
                            path: artifact.path,
                            revision: report.revision,
                            fromReport: true,
                            availablePaths: report.files.map((artifact) => artifact.path),
                          })
                        }
                      >
                        <FileText className="size-3.5 shrink-0" />
                        <span className="truncate">
                          {artifact.path.replace(/^results\/[^/]+\//, "")}
                        </span>
                      </button>
                    ))}
                    {report.pullRequests.map((url) => (
                      <button
                        type="button"
                        key={url}
                        className="control-interaction text-text-secondary hover:bg-control-hover flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs"
                        onClick={() => {
                          void native.window
                            .openExternal(url)
                            .catch((error) => toast.error(getErrorMessage(error)));
                        }}
                      >
                        <GitPullRequest className="size-3.5 shrink-0" />
                        <span className="truncate">{url.replace(/^https?:\/\//, "")}</span>
                        <ArrowUpRight className="ml-auto size-3 shrink-0" />
                      </button>
                    ))}
                  </div>
                )}
                <div className="mt-3 flex items-center justify-between gap-2">
                  <button
                    type="button"
                    className="control-interaction text-text-tertiary hover:text-text-primary rounded text-xs"
                    onClick={() => {
                      const agent = project.agents.find((item) => item.id === report.agentId);
                      if (agent) onOpenAgent(agent);
                    }}
                  >
                    View conversation
                  </button>
                  {!report.accepted && report.ready === true && canEdit && (
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={action.isPending}
                      onClick={() =>
                        run({
                          action: "accept",
                          reportId: report.id,
                          requestId: crypto.randomUUID(),
                        })
                      }
                    >
                      Accept result
                    </Button>
                  )}
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
