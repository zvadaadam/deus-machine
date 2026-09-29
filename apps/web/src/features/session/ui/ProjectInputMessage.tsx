/**
 * The user echo of a Project dispatch. The person's own words stay ordinary
 * bubbles; messages from other agents are bubbles captioned with their sender;
 * machine inputs (the welcome, an agent's finished turn) are quiet event rows.
 */

import { memo, useId, useState, type ReactNode } from "react";
import {
  ArrowUpRight,
  ChevronDown,
  CircleCheck,
  CircleStop,
  CircleX,
  MessageSquare,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import type { ProjectAgent } from "@shared/projects";
import type { ProjectPromptSegment } from "@shared/project-prompt";
import { cn } from "@/shared/lib/utils";
import {
  useProjectConversation,
  type ProjectConversationValue,
} from "../context/ProjectConversationContext";
import { describeOutcome } from "../lib/projectInputs";
import { UserBubble } from "./UserBubble";

type InputSegment = Extract<ProjectPromptSegment, { type: "input" }>;

const MESSAGE_KIND_LABELS: Record<string, string> = {
  direction: "Assignment from",
  question: "Question from",
  reply: "Reply from",
  message: "Message from",
};

function agentName(agents: ProjectAgent[], id: string | null | undefined): string {
  const agent = agents.find((item) => item.id === id);
  if (!agent) return "An agent";
  return agent.role === "coordinator" ? "Coordinator" : agent.title;
}

function OpenAgentButton({
  project,
  agentId,
  name,
}: {
  project: ProjectConversationValue;
  agentId: string | null;
  name: string;
}) {
  const openAgent = project.openAgent;
  if (!openAgent || !agentId || !project.agents.some((agent) => agent.id === agentId)) return null;
  return (
    <button
      type="button"
      aria-label={`Open ${name}`}
      onClick={() => openAgent(agentId)}
      className="control-interaction text-text-tertiary hover:text-text-primary inline-flex shrink-0 items-center gap-0.5 rounded"
    >
      Open
      <ArrowUpRight aria-hidden className="size-3" />
    </button>
  );
}

function ProjectEvent({
  icon: Icon,
  label,
  detail,
  collapsed,
  action,
  tone = "done",
}: {
  icon: LucideIcon;
  label: string;
  detail: string | null;
  /** Hide the detail behind a disclosure instead of previewing two lines. */
  collapsed?: boolean;
  action?: ReactNode;
  tone?: "done" | "stopped" | "failed";
}) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const showDetail = Boolean(detail) && (!collapsed || open);
  return (
    <div className="flex items-start gap-2 px-2 py-1 text-xs" data-slot="project-event">
      <Icon
        aria-hidden
        className={cn(
          "mt-0.5 size-3.5 shrink-0",
          tone === "failed" ? "text-destructive" : "text-text-tertiary"
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-text-secondary truncate font-medium">{label}</span>
          {collapsed && detail && (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={detailId}
              onClick={() => setOpen(!open)}
              className="control-interaction text-text-tertiary hover:text-text-secondary inline-flex shrink-0 items-center gap-0.5 rounded"
            >
              Instructions
              <ChevronDown
                aria-hidden
                className={cn("size-3 transition-transform duration-150", open && "rotate-180")}
              />
            </button>
          )}
          {action}
        </div>
        {showDetail && (
          <p
            id={detailId}
            className={cn(
              "text-text-tertiary mt-1 leading-relaxed whitespace-pre-wrap",
              !collapsed && "line-clamp-2"
            )}
          >
            {detail}
          </p>
        )}
      </div>
    </div>
  );
}

function InputSegmentView({
  segment,
  id,
  project,
}: {
  segment: InputSegment;
  id: string;
  project: ProjectConversationValue;
}) {
  if (segment.origin === "human") return <UserBubble id={id} texts={[segment.text]} />;
  if (segment.origin === "agent") {
    const name = agentName(project.agents, segment.fromAgentId);
    return (
      <UserBubble
        id={id}
        texts={[segment.text]}
        caption={
          <>
            <span className="truncate">
              {MESSAGE_KIND_LABELS[segment.kind] ?? "Message from"}{" "}
              <span className="text-text-secondary font-medium">{name}</span>
            </span>
            <OpenAgentButton project={project} agentId={segment.fromAgentId} name={name} />
          </>
        }
      />
    );
  }
  if (segment.kind === "welcome")
    return <ProjectEvent icon={Sparkles} label="Project started" detail={segment.text} collapsed />;
  if (segment.kind === "turn_outcome") {
    const outcome = describeOutcome(segment.text);
    const agentId = outcome.agentId ?? segment.fromAgentId;
    const name = agentName(project.agents, agentId);
    return (
      <ProjectEvent
        icon={
          outcome.tone === "failed"
            ? CircleX
            : outcome.tone === "stopped"
              ? CircleStop
              : CircleCheck
        }
        tone={outcome.tone}
        label={`${name} ${outcome.verb}`}
        detail={outcome.detail}
        action={<OpenAgentButton project={project} agentId={agentId} name={name} />}
      />
    );
  }
  return (
    <ProjectEvent icon={MessageSquare} label="Project update" detail={segment.text} collapsed />
  );
}

export const ProjectInputMessage = memo(function ProjectInputMessage({
  messageId,
  segments,
}: {
  messageId: string;
  segments: ProjectPromptSegment[];
}) {
  const project = useProjectConversation();
  if (!project) return null;
  return (
    <div className="flex flex-col gap-2" data-slot="project-inputs">
      {segments.map((segment, index) => {
        const id = `${messageId}:${index}`;
        return segment.type === "text" ? (
          <UserBubble key={id} id={id} texts={[segment.text]} />
        ) : (
          <InputSegmentView key={id} id={id} segment={segment} project={project} />
        );
      })}
    </div>
  );
});
