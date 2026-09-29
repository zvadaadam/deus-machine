/**
 * Project tools (mcp__deus__create_agent, send_to_agent, …). Inside a Project,
 * the agent a call is about can be opened as a tab next to the coordinator.
 */

import {
  ArrowUpRight,
  FileText,
  MessageSquare,
  ScrollText,
  Square,
  UserPlus,
  Users,
} from "lucide-react";
import type { ProjectAgent } from "@shared/projects";
import { useProjectConversation } from "../../../context/ProjectConversationContext";
import { BaseToolRenderer } from "../components";
import { extractText, ICON_CLS, OutputBlock } from "./shared";
import type { ToolRendererProps } from "../../chat-types";

function parseJson<T>(output: string): T | null {
  try {
    const parsed = JSON.parse(output) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as T) : null;
  } catch {
    return null;
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/** Tools address the coordinator as "coordinator"; everything else by agent ID. */
function useAgent(agentId: string | null) {
  const project = useProjectConversation();
  const agent: ProjectAgent | undefined =
    agentId === "coordinator"
      ? project?.agents.find((item) => item.role === "coordinator")
      : project?.agents.find((item) => item.id === agentId);
  const name = agent ? (agent.role === "coordinator" ? "Coordinator" : agent.title) : null;
  const open = agent && project?.openAgent ? () => project.openAgent?.(agent.id) : null;
  return { name, open };
}

function OpenAgent({ name, onOpen }: { name: string; onOpen: (() => void) | null }) {
  if (!onOpen) return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open ${name}`}
      className="control-interaction border-border-default bg-bg-base text-text-secondary hover:text-text-primary flex h-7 w-fit items-center gap-1 rounded-lg border px-2.5 text-sm font-medium"
    >
      Open
      <ArrowUpRight aria-hidden className="size-3.5" />
    </button>
  );
}

function AgentCard({
  title,
  body,
  onOpen,
}: {
  title: string;
  body: string | null;
  onOpen: (() => void) | null;
}) {
  return (
    <div className="border-border-subtle bg-bg-elevated mx-2 mb-2 flex flex-col gap-2 rounded-lg border p-3">
      <span className="text-text-primary truncate text-sm font-medium">{title}</span>
      {body && (
        <p className="text-text-secondary line-clamp-4 text-xs leading-relaxed whitespace-pre-wrap">
          {body}
        </p>
      )}
      <OpenAgent name={title} onOpen={onOpen} />
    </div>
  );
}

export function CreateAgentToolRenderer({ toolUse, toolResult, isLoading }: ToolRendererProps) {
  const input = toolUse.input ?? {};
  const output = toolResult && !toolResult.is_error ? extractText(toolResult.content) : "";
  const created = parseJson<{ agentId?: string }>(output);
  const title = text(input.title) ?? "New agent";
  const { name, open } = useAgent(created?.agentId ?? null);
  return (
    <BaseToolRenderer
      toolName="Create agent"
      icon={<UserPlus className={ICON_CLS} />}
      toolUse={toolUse}
      toolResult={toolResult}
      isLoading={isLoading}
      defaultExpanded
      renderSummary={() => <span className="text-muted-foreground">{title}</span>}
      renderContent={() => (
        <AgentCard title={name ?? title} body={text(input.task)} onOpen={open} />
      )}
    />
  );
}

const MESSAGE_LABELS: Record<string, string> = {
  question: "Ask",
  reply: "Reply to",
  message: "Message",
};

export function SendToAgentToolRenderer({ toolUse, toolResult, isLoading }: ToolRendererProps) {
  const input = toolUse.input ?? {};
  const target = text(input.agentId);
  const { name, open } = useAgent(target);
  const kind = text(input.kind) ?? "message";
  const recipient = name ?? (target === "coordinator" ? "Coordinator" : "agent");
  return (
    <BaseToolRenderer
      toolName={`${MESSAGE_LABELS[kind] ?? "Message"} ${recipient}`}
      icon={<MessageSquare className={ICON_CLS} />}
      toolUse={toolUse}
      toolResult={toolResult}
      isLoading={isLoading}
      renderSummary={() => (
        <span className="text-muted-foreground">{text(input.message)?.split("\n")[0]}</span>
      )}
      renderContent={() => (
        <div className="mx-2 mb-2 flex flex-col gap-2">
          {text(input.message) && (
            <p className="text-text-secondary text-xs leading-relaxed whitespace-pre-wrap">
              {input.message}
            </p>
          )}
          <OpenAgent name={recipient} onOpen={open} />
        </div>
      )}
    />
  );
}

export function StopAgentToolRenderer({ toolUse, toolResult, isLoading }: ToolRendererProps) {
  const { name, open } = useAgent(text(toolUse.input?.agentId));
  return (
    <BaseToolRenderer
      toolName="Stop agent"
      icon={<Square className={ICON_CLS} />}
      toolUse={toolUse}
      toolResult={toolResult}
      isLoading={isLoading}
      renderSummary={() => <span className="text-muted-foreground">{name}</span>}
      renderContent={() => (
        <div className="mx-2 mb-2">
          <OpenAgent name={name ?? "agent"} onOpen={open} />
        </div>
      )}
    />
  );
}

export function AgentStatusToolRenderer({ toolUse, toolResult, isLoading }: ToolRendererProps) {
  const target = text(toolUse.input?.agentId);
  const { name } = useAgent(target);
  const output = toolResult && !toolResult.is_error ? extractText(toolResult.content) : "";
  const status = parseJson<{ agents?: { title?: string; status?: string; role?: string }[] }>(
    output
  );
  return (
    <BaseToolRenderer
      toolName="Check agents"
      icon={<Users className={ICON_CLS} />}
      toolUse={toolUse}
      toolResult={toolResult}
      isLoading={isLoading}
      renderSummary={() => (
        <span className="text-muted-foreground">{target ? name : "All agents"}</span>
      )}
      renderContent={() =>
        status?.agents ? (
          <div className="mx-2 mb-2 flex flex-col gap-1">
            {status.agents.map((agent, index) => (
              <div key={index} className="flex items-baseline gap-2 px-1 text-xs">
                <span className="text-text-primary font-medium">
                  {agent.role === "coordinator" ? "Coordinator" : agent.title}
                </span>
                <span className="text-text-muted">{agent.status}</span>
              </div>
            ))}
          </div>
        ) : output ? (
          <OutputBlock>{output}</OutputBlock>
        ) : null
      }
    />
  );
}

export function ReadAgentTranscriptToolRenderer({
  toolUse,
  toolResult,
  isLoading,
}: ToolRendererProps) {
  const { name, open } = useAgent(text(toolUse.input?.agentId));
  const output = toolResult && !toolResult.is_error ? extractText(toolResult.content) : "";
  const transcript = parseJson<{ transcript?: string }>(output)?.transcript ?? output;
  return (
    <BaseToolRenderer
      toolName="Read transcript"
      icon={<ScrollText className={ICON_CLS} />}
      toolUse={toolUse}
      toolResult={toolResult}
      isLoading={isLoading}
      renderSummary={() => <span className="text-muted-foreground">{name}</span>}
      renderContent={() => (
        <div className="mx-2 mb-2 flex flex-col gap-2">
          {transcript && <OutputBlock>{transcript}</OutputBlock>}
          <OpenAgent name={name ?? "agent"} onOpen={open} />
        </div>
      )}
    />
  );
}

export function ReportResultToolRenderer({ toolUse, toolResult, isLoading }: ToolRendererProps) {
  const input = toolUse.input ?? {};
  const summary = text(input.summary);
  const files = Array.isArray(input.files) ? (input.files as { path?: string }[]) : [];
  return (
    <BaseToolRenderer
      toolName="Report result"
      icon={<FileText className={ICON_CLS} />}
      toolUse={toolUse}
      toolResult={toolResult}
      isLoading={isLoading}
      renderSummary={() => <span className="text-muted-foreground">{summary?.split("\n")[0]}</span>}
      renderContent={() => (
        <div className="mx-2 mb-2 flex flex-col gap-2">
          {summary && (
            <p className="text-text-secondary text-xs leading-relaxed whitespace-pre-wrap">
              {summary}
            </p>
          )}
          {files.length > 0 && (
            <ul className="text-text-tertiary flex flex-col gap-0.5 text-xs">
              {files.map((file, index) => (
                <li key={file.path ?? index} className="truncate font-mono">
                  {file.path}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    />
  );
}

const DOCUMENT_LABELS: Record<string, string> = {
  list: "List documents",
  read: "Read document",
  publish: "Publish document",
};

export function PublishContextToolRenderer({ toolUse, toolResult, isLoading }: ToolRendererProps) {
  const input = toolUse.input ?? {};
  const mode = text(input.mode) ?? "read";
  const output = toolResult ? extractText(toolResult.content) : "";
  return (
    <BaseToolRenderer
      toolName={DOCUMENT_LABELS[mode] ?? "Documents"}
      icon={<FileText className={ICON_CLS} />}
      toolUse={toolUse}
      toolResult={toolResult}
      isLoading={isLoading}
      renderSummary={() => <span className="text-muted-foreground">{text(input.path)}</span>}
      renderContent={() => (output ? <OutputBlock>{output}</OutputBlock> : null)}
    />
  );
}
