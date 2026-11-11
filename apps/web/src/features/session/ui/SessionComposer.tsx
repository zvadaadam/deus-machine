/**
 * SessionComposer — stateful wrapper around the presentational MessageInput.
 *
 * Responsibilities:
 *   1. Render `<MessageInput sessionId>` for the active session.
 *      MessageInput subscribes to `sessionComposerStore` directly for
 *      every piece of staged content.
 *   2. Provide session-derived props (sending, context tokens, manifest
 *      status, etc.) that need React Query hooks.
 *   3. Own the send path via `useSessionActions`; clear staged content
 *      on successful send.
 *   4. Expose a narrow imperative ref for the home-screen welcome flow
 *      (which dispatches before a composer is mounted) and for parents
 *      that forward stop/compact/createPR callbacks.
 *
 * When `sessionId` is null (workspace with no chat yet), renders a
 * disabled placeholder — caller doesn't need to branch.
 */

import { forwardRef, useEffect, useImperativeHandle, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { MessageInput } from "./MessageInput";
import { useSessionActions } from "../hooks";
import { useSessionWithMessages } from "../api/session.queries";
import { useProjectEnvironment } from "@/features/workspace/api/workspace.queries";
import { useDefaultThinkingLevel } from "@/features/settings/api";
import {
  DEFAULT_MODEL,
  fitThinkingLevel,
  getAgentHarnessForModel,
  getModelId,
  modelThinkingLevels,
  type AgentHarness,
  type ThinkingLevel,
  getModelForSession,
} from "@/shared/agents";
import { useModelLists } from "@/shared/hooks/useModelLists";
import {
  emptyComposer,
  sessionComposerActions,
  useSessionComposerStore,
} from "../store/sessionComposerStore";

export interface SessionComposerRef {
  /** Send a message bypassing the UI event path. Used by the home-screen
   *  welcome flow, which dispatches before a composer surface mounts.
   *  `modelOverride` forces a model for THIS send only and also updates
   *  the composer store so subsequent sends keep it; `thinkingOverride` is
   *  the level picked with it, fitted to what the model offers. */
  sendMessage: (
    content: string,
    modelOverride?: string,
    thinkingOverride?: ThinkingLevel
  ) => Promise<boolean>;
  stopSession: () => Promise<void>;
  compactConversation: () => Promise<boolean>;
  createPR: () => Promise<boolean>;
}

interface SessionComposerProps {
  /** Active session — null renders a disabled pill. */
  sessionId: string | null;
  workspaceId?: string | null;
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
  onOpenNewTab?: (initialModel?: string) => void;
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

    // Session-derived props — everything that needs React Query context.
    // Composer state itself (draft/model/etc.) lives in the store;
    // MessageInput reads it directly. We don't subscribe here.
    const { session, messages, turns, error, retry, sessionStatus } =
      useSessionWithMessages(sessionId);
    const environment = useProjectEnvironment(workspaceId);
    const modelLists = useModelLists({ cloud: session?.workspace_kind === "cloud", workspaceId });
    const environmentUnconfigured =
      environment.isSuccess && environment.data.source === "unconfigured";
    const seedModel =
      initialModel ??
      (session ? getModelForSession(session.agent_harness, turns ?? []) : DEFAULT_MODEL);

    // Notify parent when the selected model's agent harness changes.
    // We subscribe to just `model` (a string) to avoid re-renders on
    // unrelated staged-content changes like paste.
    const model = useSessionComposerStore((s) => s.composers[sessionId]?.model ?? seedModel);
    const agentHarness = getAgentHarnessForModel(model);
    useEffect(() => {
      onAgentHarnessChange?.(agentHarness);
    }, [agentHarness, onAgentHarnessChange]);

    const { sendMessage, stopSession, compactConversation, createPR, sending } = useSessionActions({
      sessionId,
      workspaceId: workspaceId ?? undefined,
      targetBranch: targetBranch ?? "main",
      onMessageSent: () => {
        sessionComposerActions.clearContent(sessionId);
        onSendComplete?.();
      },
    });

    useImperativeHandle(
      ref,
      () => ({
        sendMessage: async (content, modelOverride, thinkingOverride) => {
          if (modelOverride) {
            // Welcome sends carry an explicit model before history mounts the input.
            const levels = modelThinkingLevels(
              modelLists,
              getAgentHarnessForModel(modelOverride),
              getModelId(modelOverride)
            );
            sessionComposerActions.seedIfAbsent(
              sessionId,
              emptyComposer(modelOverride, defaultThinking)
            );
            sessionComposerActions.setModel(sessionId, modelOverride, levels, defaultThinking);
            if (thinkingOverride) {
              sessionComposerActions.setThinkingLevel(
                sessionId,
                fitThinkingLevel(thinkingOverride, levels, defaultThinking)
              );
            }
          }
          return sendMessage(content, modelOverride);
        },
        stopSession,
        compactConversation,
        createPR,
      }),
      [
        sendMessage,
        stopSession,
        compactConversation,
        createPR,
        sessionId,
        defaultThinking,
        modelLists,
      ]
    );

    // The composer seeds its model ONCE (seedIfAbsent on first mount), so the
    // seed must be right the first time: an explicit pick for a new tab wins,
    // otherwise wait for history and restore the last recorded model.
    if ((!session || turns === undefined) && !initialModel) {
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
        initialModel={seedModel}
        defaultThinking={defaultThinking}
        sending={sending}
        sessionStatus={sessionStatus}
        workspaceKind={session?.workspace_kind}
        contextTokenCount={session?.context_token_count ?? 0}
        contextUsedPercent={session?.context_used_percent ?? 0}
        hasMessages={messages.length > 0}
        environmentUnconfigured={environmentUnconfigured}
        showCompactButton={showCompactButton}
        onSend={(content) => sendMessage(content)}
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
