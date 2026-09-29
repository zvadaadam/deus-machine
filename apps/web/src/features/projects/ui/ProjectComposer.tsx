import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Play } from "lucide-react";
import { toast } from "sonner";
import { InputGroupButton } from "@/components/ui/input-group";
import { ComposerInput } from "@/features/session/ui/ComposerInput";
import { ModelPicker } from "@/features/session/ui/ModelPicker";
import type { SessionComposerRef } from "@/features/session/ui/SessionComposer";
import {
  useSessionComposerStore,
  sessionComposerActions,
  emptyComposer,
} from "@/features/session/store/sessionComposerStore";
import { apiClient } from "@/shared/api/client";
import { getErrorMessage } from "@shared/lib/errors";
import { useProject, useProjectAction } from "../api/projects.queries";
import { ProjectMessageQueue } from "./ProjectMessageQueue";

export interface ManagedProjectComposer {
  projectId: string;
  agentId: string;
  current: boolean;
}

/** A queued Project input has no executor turn ID until the owner dispatches it. */
export const ProjectComposer = forwardRef<
  SessionComposerRef,
  ManagedProjectComposer & { sessionId: string; onSendComplete?: () => void }
>(function ProjectComposer({ projectId, agentId, current, sessionId, onSendComplete }, ref) {
  const projectQuery = useProject(projectId);
  const project = projectQuery.data;
  const agent = project?.agents.find((item) => item.id === agentId);
  const action = useProjectAction(projectId);
  const [error, setError] = useState<string | null>(null);
  const pendingRequest = useRef<{ content: string; requestId: string } | null>(null);
  const draft = useSessionComposerStore((state) => state.composers[sessionId]?.draft ?? "");
  const model = project?.model;
  useEffect(() => {
    if (!model) return;
    sessionComposerActions.seedIfAbsent(
      sessionId,
      emptyComposer(`claude-code:${model.replace(/^claude-code:/, "")}`, "high")
    );
  }, [sessionId, model]);
  const send = useMutation({
    mutationFn: (input: { message: string; requestId: string }) =>
      apiClient.post(`/projects/${encodeURIComponent(projectId)}/message`, { ...input, agentId }),
  });
  const disabled = !current || !project || project.status === "archived";
  const sendMessage = async (customContent?: string) => {
    const content = (
      customContent ??
      useSessionComposerStore.getState().composers[sessionId]?.draft ??
      ""
    ).trim();
    if (disabled || !content || send.isPending) return false;
    if (pendingRequest.current?.content !== content)
      pendingRequest.current = { content, requestId: crypto.randomUUID() };
    try {
      await send.mutateAsync({ message: content, requestId: pendingRequest.current.requestId });
      sessionComposerActions.clearContent(sessionId);
      pendingRequest.current = null;
      setError(null);
      onSendComplete?.();
      toast.success("Message queued");
      return true;
    } catch (failure) {
      setError(getErrorMessage(failure));
      return false;
    }
  };
  const stopSession = async () => {
    try {
      await action.mutateAsync({ action: "stop", agentId, requestId: crypto.randomUUID() });
    } catch (failure) {
      toast.error(getErrorMessage(failure));
    }
  };
  useImperativeHandle(ref, () => ({
    sendMessage,
    stopSession,
    compactConversation: () =>
      sendMessage("Summarize the current work and remaining steps before continuing."),
    createPR: () =>
      sendMessage(
        "Create a pull request for the completed work and include its URL in your result."
      ),
  }));

  if (!current)
    return (
      <p className="text-text-tertiary border-border-subtle border-t px-4 py-3 text-xs">
        This conversation is retained as project history.
      </p>
    );
  if (project?.status === "archived")
    return (
      <p className="text-text-tertiary border-border-subtle border-t px-4 py-3 text-xs">
        This project is archived. Its conversations and results are retained.
      </p>
    );
  const working = agent?.status === "working" || agent?.status === "stopping";
  const statusMessage =
    agent?.status === "stopping"
      ? "Stopping the current turn…"
      : working
        ? "Your message runs after this turn"
        : project?.paused || agent?.paused
          ? "Queued until resumed"
          : null;
  return (
    <div className="relative z-20 shrink-0 px-2 pb-2" data-slot="project-composer">
      {project && <ProjectMessageQueue project={project} agentId={agentId} />}
      <ComposerInput
        textarea={{
          "aria-label": agent?.role === "coordinator" ? "Message coordinator" : "Message agent",
          placeholder: project?.paused
            ? "Message saved for when this project resumes…"
            : agent?.role === "coordinator"
              ? "Give your coordinator direction…"
              : "Send this agent a follow-up…",
          value: draft,
          maxLength: 20000,
          onChange: (event) => {
            if (!project) return;
            sessionComposerActions.setDraft(sessionId, event.target.value);
          },
        }}
        hasContent={!!draft.trim()}
        sending={send.isPending}
        disabled={disabled}
        onSend={() => void sendMessage()}
        onStop={working ? () => void stopSession() : undefined}
        stopDisabled={action.isPending}
        modelControls={
          model && (
            <ModelPicker
              model={`claude-code:${model.replace(/^claude-code:/, "")}`}
              hasMessages
              readOnly
            />
          )
        }
        actions={
          agent?.paused &&
          !project?.paused && (
            <InputGroupButton
              variant="ghost"
              size="sm"
              disabled={action.isPending}
              onClick={() =>
                action.mutate(
                  { action: "resume-agent", agentId, requestId: crypto.randomUUID() },
                  { onError: (failure) => toast.error(getErrorMessage(failure)) }
                )
              }
            >
              <Play />
              Resume
            </InputGroupButton>
          )
        }
        feedback={
          <div className="w-full space-y-1 px-4 text-xs">
            {error && (
              <p role="alert" className="text-destructive pb-2">
                {error}
              </p>
            )}
            {projectQuery.isError && (
              <p role="alert" className="text-destructive pb-2">
                Could not load project controls. {getErrorMessage(projectQuery.error)}
              </p>
            )}
            {statusMessage && <p className="text-text-tertiary pb-2">{statusMessage}</p>}
          </div>
        }
      />
    </div>
  );
});
