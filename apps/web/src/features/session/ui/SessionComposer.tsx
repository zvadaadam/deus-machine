import type { OpenChatWithModel } from "@/shared/agents/picker";
import { chatHasStarted } from "@shared/gateways";
import { forwardRef, useEffect, useImperativeHandle, type ReactNode } from "react";
import type { WorkspaceKind } from "@shared/enums";
import { useStore } from "zustand";
import { Button } from "@/components/ui/button";
import { MessageInput } from "./MessageInput";
import { useSessionActions } from "../hooks";
import { useSessionWithMessages } from "../api/session.queries";
import { openConversationTurn } from "../lib/conversationView";
import { useProjectEnvironment } from "@/features/workspace/api/workspace.queries";
import { useDefaultThinkingLevel } from "@/features/settings/api";
import { type AgentHarness, getThinkingForSession } from "@/shared/agents";
import { useChatModel } from "@/shared/hooks/useModelLists";
import { composerStore } from "../store/sessionComposerStore";

export interface SessionComposerRef {
  /** Send a message bypassing the UI event path (header actions that ask
   *  the agent for something: create a PR, fix the setup script). */
  sendMessage: (content: string) => Promise<boolean>;
  stopSession: () => Promise<void>;
  compactConversation: () => Promise<boolean>;
  createPR: () => Promise<boolean>;
}

interface SessionComposerProps {
  /** Active session — null renders a disabled pill. */
  sessionId: string | null;
  workspaceId?: string | null;
  workspaceKind?: WorkspaceKind;
  workspacePath?: string | null;
  /** Target branch for createPR prompts (defaults to "main"). */
  targetBranch?: string;
  /** Seed model on first mount; ignored if the session is already seeded. */
  initialModel?: string;
  /** Show the Compact button (modal layout wants it). */
  showCompactButton?: boolean;
  /** Direct cloud history comes from the panel's socket, not the message query. */
  historyConnection?: {
    error: string | null;
    retry: () => void;
    retrying: boolean;
  };
  /** Called when user picks a model from a locked agent group. */
  onOpenNewTab?: OpenChatWithModel;
  /** Reports the current agent harness to parents that gate on it. */
  onAgentHarnessChange?: (harness: AgentHarness) => void;
  /** Fires after a successful send. */
  onSendComplete?: () => void;
  className?: string;
}

/** Props accepted when we know sessionId is non-null. */
type ActiveProps = Omit<SessionComposerProps, "sessionId" | "workspaceId"> & {
  sessionId: string;
  workspaceId: string | null;
};

export const SessionComposer = forwardRef<SessionComposerRef, SessionComposerProps>(
  function SessionComposer(props, ref) {
    if (!props.sessionId) {
      return <DisabledComposerPlaceholder className={props.className} />;
    }
    return (
      <ActiveSessionComposer
        {...props}
        sessionId={props.sessionId}
        workspaceId={props.workspaceId ?? null}
        ref={ref}
      />
    );
  }
);

const ActiveSessionComposer = forwardRef<SessionComposerRef, ActiveProps>(
  function ActiveSessionComposer(
    {
      sessionId,
      workspaceId,
      workspaceKind: parentKind,
      workspacePath = null,
      targetBranch,
      initialModel,
      showCompactButton = false,
      historyConnection,
      onOpenNewTab,
      onAgentHarnessChange,
      onSendComplete,
      className,
    },
    ref
  ) {
    const defaultThinking = useDefaultThinkingLevel();

    const { session, messages, turns, error, retry, sessionStatus } =
      useSessionWithMessages(sessionId);
    const workspaceKind = parentKind ?? session?.workspace_kind;
    const steerTurnId =
      workspaceKind === "worktree" && sessionStatus === "working"
        ? openConversationTurn(messages.at(-1)?.turn_id, true, turns)?.turnId
        : undefined;
    const environment = useProjectEnvironment(workspaceId);
    const environmentUnconfigured =
      environment.isSuccess && environment.data.source === "unconfigured";
    // The chat reopens on the level its latest turn ran, as on its model. The
    // user's setting stays the level a model switch falls back to.
    const seedThinking = session
      ? getThinkingForSession(session.agent_harness, turns ?? [], defaultThinking)
      : defaultThinking;

    const pickedModel = useStore(composerStore(), (s) => s.composers[sessionId]?.model);
    const started = chatHasStarted(session ?? {});
    const hasMessages = started || messages.length > 0;
    const selection = useChatModel({
      cloud: workspaceKind === "cloud",
      workspaceId,
      harness: session?.agent_harness,
      turns,
      gatewayGeneration: started ? (session?.gateway_generation ?? null) : undefined,
      picked: pickedModel ?? initialModel,
    });
    const { agentHarness } = selection;
    const loadFailed = !!error || !!historyConnection?.error;
    const needsHistory =
      (!session || turns === undefined) && (!selection.picked || (loadFailed && !initialModel));
    useEffect(() => {
      if (agentHarness) onAgentHarnessChange?.(agentHarness);
    }, [agentHarness, onAgentHarnessChange]);

    const { sendMessage, stopSession, compactConversation, createPR, sending } = useSessionActions({
      sessionId,
      steerTurnId,
      model: needsHistory || selection.unavailable ? undefined : selection.model,
      gatewayModel: selection.gatewayModel,
      workspaceId: workspaceId ?? undefined,
      workspaceKind,
      targetBranch: targetBranch ?? "main",
      onMessageSent: onSendComplete,
      onOpenNewTab,
    });

    useImperativeHandle(
      ref,
      () => ({
        sendMessage: (content) => sendMessage(content),
        stopSession,
        compactConversation,
        createPR,
      }),
      [sendMessage, stopSession, compactConversation, createPR]
    );

    // Without a pick from a tab or its start page, wait for the model from history.
    if (needsHistory) {
      return (
        <DisabledComposerPlaceholder className={className}>
          {error || historyConnection?.error ? (
            <div role="alert" className="flex items-center justify-between gap-3">
              <span>Couldn’t load this conversation.</span>
              <Button
                size="sm"
                variant="ghost"
                disabled={historyConnection?.retrying}
                onClick={() =>
                  void (historyConnection?.error ? historyConnection.retry() : retry())
                }
              >
                Try again
              </Button>
            </div>
          ) : (
            "Loading conversation…"
          )}
        </DisabledComposerPlaceholder>
      );
    }
    return (
      // Key on sessionId so MessageInput's LOCAL UI state (popover open,
      // query buffers) resets when the session changes. Staged content
      // transitions smoothly because it comes from the store.
      <MessageInput
        key={sessionId}
        sessionId={sessionId}
        workspaceId={workspaceId}
        workspacePath={workspacePath}
        selection={selection}
        initialThinking={seedThinking}
        defaultThinking={defaultThinking}
        sending={sending}
        sessionStatus={sessionStatus}
        steerTurnId={steerTurnId}
        workspaceKind={workspaceKind}
        contextTokenCount={session?.context_token_count ?? 0}
        contextUsedPercent={session?.context_used_percent ?? 0}
        hasMessages={hasMessages}
        environmentUnconfigured={environmentUnconfigured}
        showCompactButton={showCompactButton}
        onSend={sendMessage}
        onCompact={compactConversation}
        onStop={stopSession}
        onOpenNewTab={onOpenNewTab}
        className={className}
      />
    );
  }
);

function DisabledComposerPlaceholder({
  className,
  children,
}: {
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={`relative z-20 shrink-0 px-2 pb-2 ${className ?? ""}`}>
      <div className="bg-input-surface text-text-muted rounded-2xl px-4 py-3 text-sm shadow-xs">
        {children ?? "Start a chat to send messages."}
      </div>
    </div>
  );
}
