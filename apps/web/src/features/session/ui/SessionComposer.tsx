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

import { forwardRef, useEffect, useImperativeHandle } from "react";
import { MessageInput } from "./MessageInput";
import { useSessionActions } from "../hooks";
import { useSessionWithMessages } from "../api/session.queries";
import { useManifestTasks } from "@/features/workspace/api/workspace.queries";
import { useSettings } from "@/features/settings/api";
import { getAgentHarnessForModel, type AgentHarness, type ThinkingLevel } from "@/shared/agents";
import { sessionComposerActions, useSessionComposerStore } from "../store/sessionComposerStore";

export interface SessionComposerRef {
  /** Send a message bypassing the UI event path. Used by the home-screen
   *  welcome flow, which dispatches before a composer surface mounts.
   *  `modelOverride` forces a model for THIS send only and also updates
   *  the composer store so subsequent sends keep it. */
  sendMessage: (content: string, modelOverride?: string) => Promise<void>;
  stopSession: () => Promise<void>;
  compactConversation: () => Promise<void>;
  createPR: () => Promise<void>;
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
  /** SessionPanel owns the RPC handler; it feeds the boolean in. */
  hasPendingPlan?: boolean;
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

const FALLBACK_MODEL = "claude:claude-opus-4-7";

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
      hasPendingPlan = false,
      onOpenNewTab,
      onAgentHarnessChange,
      onSendComplete,
      className,
    },
    ref
  ) {
    const { data: settings } = useSettings();
    const defaultThinking: ThinkingLevel = settings?.default_thinking_level ?? "HIGH";

    // Session-derived props — everything that needs React Query context.
    // Composer state itself (draft/model/etc.) lives in the store;
    // MessageInput reads it directly. We don't subscribe here.
    const { session, messages, sessionStatus } = useSessionWithMessages(sessionId);
    const { data: manifestData } = useManifestTasks(workspaceId);
    const hasManifest = manifestData === undefined ? true : manifestData?.manifest != null;

    // Notify parent when the selected model's agent harness changes.
    // We subscribe to just `model` (a string) to avoid re-renders on
    // unrelated staged-content changes like paste.
    const model = useSessionComposerStore(
      (s) => s.composers[sessionId]?.model ?? initialModel ?? FALLBACK_MODEL
    );
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
        sendMessage: async (content, modelOverride) => {
          if (modelOverride) {
            sessionComposerActions.setModel(sessionId, modelOverride, defaultThinking);
          }
          await sendMessage(content, modelOverride);
        },
        stopSession,
        compactConversation,
        createPR,
      }),
      [sendMessage, stopSession, compactConversation, createPR, sessionId, defaultThinking]
    );

    return (
      // Key on sessionId so MessageInput's LOCAL UI state (popover open,
      // query buffers) resets when the session changes. Staged content
      // transitions smoothly because it comes from the store.
      <MessageInput
        key={sessionId}
        sessionId={sessionId}
        workspaceId={workspaceId}
        workspacePath={workspacePath}
        initialModel={initialModel}
        defaultThinking={defaultThinking}
        sending={sending}
        sessionStatus={sessionStatus}
        contextTokenCount={session?.context_token_count ?? 0}
        contextUsedPercent={session?.context_used_percent ?? 0}
        hasMessages={messages.length > 0}
        hasManifest={hasManifest}
        showCompactButton={showCompactButton}
        hasPendingPlan={hasPendingPlan}
        onSend={(content) => sendMessage(content)}
        onCompact={compactConversation}
        onStop={stopSession}
        onOpenNewTab={onOpenNewTab}
        className={className}
      />
    );
  }
);

function DisabledComposerPlaceholder({ className }: { className?: string }) {
  return (
    <div className={`relative z-20 shrink-0 px-2 pb-2 ${className ?? ""}`}>
      <div className="bg-input-surface text-text-muted rounded-2xl px-4 py-3 text-sm shadow-xs">
        Start a chat to send messages.
      </div>
    </div>
  );
}
