import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  forwardRef,
  useImperativeHandle,
} from "react";
import { Chat } from "./Chat";
import { SessionComposer, type SessionComposerRef } from "./SessionComposer";
import { usePartEvents } from "../hooks/usePartEvents";
import { useAgentRpcHandler } from "../hooks/useAgentRpcHandler";
import { SessionProvider } from "../context";
import { useSessionWithMessages, useLoadOlderMessages } from "../api/session.queries";
import { PlanApprovalOverlay } from "./PlanApprovalOverlay";
import { AgentQuestionOverlay } from "./AgentQuestionOverlay";
import { Button } from "@/components/ui/button";
import { X, Upload } from "lucide-react";
import type { AgentHarness } from "@/shared/agents";
import { workspaceLayoutActions } from "@/features/workspace/store";
import { sessionComposerActions } from "../store/sessionComposerStore";
import { processImageFiles } from "../lib/imageAttachments";

const CONTENT_WIDTH_CLASSES = "w-full max-w-[960px] mx-auto min-w-0";

interface SessionPanelProps {
  sessionId: string;
  workspacePath: string;
  workspaceId?: string;
  workspaceRepoName?: string | null;
  workspaceParentBranch?: string | null;
  /** Default branch of the repo (e.g. "main"). Used for getDiff RPC auto-response. */
  workspaceDefaultBranch?: string | null;
  isFirstSession?: boolean;
  onClose?: () => void;
  embedded?: boolean;
  onCompact?: (handler: () => void) => void;
  onCreatePR?: (handler: () => void) => void;
  onSendAgentMessage?: (handler: (text: string) => Promise<void>) => void;
  onStop?: (handler: () => void) => void;
  onAgentHarnessChange?: (agentHarness: AgentHarness) => void;
  onSessionStarted?: () => void;
  /** Opens a new chat tab with the given model pre-selected */
  onOpenNewTab?: (initialModel?: string) => void;
  /** Model to pre-select when this tab was created from the locked-group picker */
  initialModel?: string;
}

export interface SessionPanelRef {
  /** Dispatch a message from outside the React tree — needed by the
   *  home-screen welcome flow where the first send happens before the
   *  composer is mounted. All other "push content into chat" flows go
   *  directly through `sessionComposerActions`. */
  sendMessage: (content: string, model?: string) => Promise<void>;
}

export const SessionPanel = forwardRef<SessionPanelRef, SessionPanelProps>(
  (
    {
      sessionId,
      workspacePath,
      workspaceId,
      workspaceRepoName,
      workspaceParentBranch,
      workspaceDefaultBranch,
      isFirstSession,
      onClose,
      embedded = false,
      onCompact,
      onCreatePR,
      onSendAgentMessage,
      onStop,
      onAgentHarnessChange,
      onOpenNewTab,
      onSessionStarted,
      initialModel,
    },
    ref
  ) => {
    // Agent RPC handler — listens for WS tool requests and manages pending UI state.
    // sessionWorkspaces maps this session's ID to its workspace so getDiff can
    // auto-respond via backend HTTP.
    const agentRpcContext = useMemo(() => {
      const map = new Map<
        string,
        { workspaceId: string; workspacePath: string; parentBranch: string; defaultBranch: string }
      >();
      // workspacePath and workspaceId are the minimum requirements — parentBranch and
      // defaultBranch fall back to "main" when not provided so getDiff always has a
      // usable context. workspaceId is needed for HTTP diff endpoints.
      if (workspacePath && workspaceId) {
        map.set(sessionId, {
          workspaceId,
          workspacePath,
          parentBranch: workspaceParentBranch ?? "main",
          defaultBranch: workspaceDefaultBranch ?? "main",
        });
      }
      return { sessionWorkspaces: map };
    }, [sessionId, workspaceId, workspacePath, workspaceParentBranch, workspaceDefaultBranch]);

    const { pendingRequests, resolvePlanMode, resolveQuestion } =
      useAgentRpcHandler(agentRpcContext);

    // TanStack Query hooks
    const {
      session,
      messages: dbMessages,
      hasOlder,
      sessionStatus,
      loading,
    } = useSessionWithMessages(sessionId);

    // ── Part Events → direct cache mutation (single-store model) ──────
    // WS part events mutate the TanStack Query cache directly.
    // No parallel store, no merge function. One source of truth.
    usePartEvents(sessionId);

    // Messages come directly from TanStack cache (populated by DB load + WS mutations)
    const messages = dbMessages;

    // Load-older: button-triggered, not scroll-triggered
    const loadOlderMutation = useLoadOlderMessages();
    const handleLoadOlder = useCallback(() => {
      if (loadOlderMutation.isPending || !messages.length) return;
      const firstSeq = messages[0]?.seq;
      if (firstSeq == null) return;
      loadOlderMutation.mutate({ sessionId, beforeSeq: firstSeq });
    }, [loadOlderMutation, messages, sessionId]);

    // Subagent groups: derive from message.parent_tool_use_id
    const subagentMessages = useMemo(() => {
      const map = new Map<string, typeof messages>();
      for (const msg of messages) {
        if (msg.parent_tool_use_id) {
          let group = map.get(msg.parent_tool_use_id);
          if (!group) {
            group = [];
            map.set(msg.parent_tool_use_id, group);
          }
          group.push(msg);
        }
      }
      return map;
    }, [messages]);

    // Latest user message sent_at for turn duration tracking
    const latestMessageSentAt = useMemo(() => {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user" && messages[i].sent_at) {
          return messages[i].sent_at;
        }
      }
      return null;
    }, [messages]);

    // DEBUG: disabled — was flooding console, making [autoscroll] logs unreadable
    // if (import.meta.env.DEV) {
    //   console.log("[SessionPanel] DEBUG:", { sessionId, messagesCount: messages.length, loading, sessionStatus });
    // }

    // Ref to the SessionComposer — parent (ChatArea) and imperative callers
    // (browser element selector, welcome-flow sendMessage, drag & drop)
    // drive the composer via this. addFiles / addInspectedElement /
    // clearPastedContent forward to MessageInput's local state;
    // sendMessage / stopSession / compactConversation / createPR fire the
    // session actions.
    const composerRef = useRef<SessionComposerRef>(null);

    // Full-panel drag & drop — uses dragOver (fires continuously) for reliable detection
    const [isDragging, setIsDragging] = useState(false);

    const handleDragOver = useCallback(
      (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (!isDragging) setIsDragging(true);
      },
      [isDragging]
    );

    const handleDragLeave = useCallback((e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // Only dismiss when cursor truly leaves the container bounds
      const rect = e.currentTarget.getBoundingClientRect();
      if (
        e.clientX < rect.left ||
        e.clientX >= rect.right ||
        e.clientY < rect.top ||
        e.clientY >= rect.bottom
      ) {
        setIsDragging(false);
      }
    }, []);

    const handleDrop = useCallback(
      async (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) {
          const processed = await processImageFiles(files);
          if (processed.length) {
            sessionComposerActions.addImageAttachments(sessionId, processed);
          }
        }
      },
      [sessionId]
    );

    // Native drag-drop — Electron handles file drops via standard HTML5 drag-drop
    // events. The renderer has full access to File objects from the drop event,
    // so no special IPC is needed.
    // Standard HTML5 drag-drop is handled by MessageInput's existing drop handler.

    // Counter incremented when the human clicks Send — triggers auto-scroll resume
    const [userSendCount, setUserSendCount] = useState(0);

    // Show compact button when there are enough messages to benefit from compacting
    const showCompactButton = messages.length > 10;

    // Bridge parent's onCompact / onCreatePR / onSendAgentMessage / onStop
    // callbacks to the composer ref. Each wrapper reads the ref at call
    // time, so the handlers keep working across composer re-renders.
    useEffect(() => {
      onCompact?.(() => composerRef.current?.compactConversation());
      onCreatePR?.(() => composerRef.current?.createPR());
      onSendAgentMessage?.(
        (content: string) => composerRef.current?.sendMessage(content) ?? Promise.resolve()
      );
      onStop?.(() => composerRef.current?.stopSession());
    }, [onCompact, onCreatePR, onSendAgentMessage, onStop]);

    // SessionPanelRef only exposes `sendMessage` — the welcome flow's
    // sole external need. Content pushes (insertText, addInspectedElement,
    // addFiles) go directly through `sessionComposerActions` from their
    // call sites, which already have the workspaceId needed to resolve
    // the active session.
    useImperativeHandle(
      ref,
      () => ({
        sendMessage: (content: string, modelOverride?: string) =>
          composerRef.current?.sendMessage(content, modelOverride) ?? Promise.resolve(),
      }),
      []
    );

    const handleSendComplete = useCallback(() => {
      setUserSendCount((c) => c + 1);
      onSessionStarted?.();
    }, [onSessionStarted]);

    // Error action handlers
    const handleOpenLoginTerminal = useCallback(() => {
      if (!workspaceId) return;
      workspaceLayoutActions.setLayout(workspaceId, {
        activeContentTab: "terminal",
        contentPanelCollapsed: false,
      });
      workspaceLayoutActions.setPendingTerminalCommand(workspaceId, "claude login");
    }, [workspaceId]);

    const handleRetryInNewChat = useCallback(() => {
      onOpenNewTab?.();
    }, [onOpenNewTab]);

    // Pending agent request for THIS session (plan approval or questions)
    const pendingRequest = pendingRequests.get(sessionId) ?? null;
    const pendingPlan = pendingRequest?.type === "exitPlanMode" ? pendingRequest : null;
    const pendingQuestion = pendingRequest?.type === "askUserQuestion" ? pendingRequest : null;

    const handlePlanApprove = useCallback(() => {
      resolvePlanMode(sessionId, true);
    }, [resolvePlanMode, sessionId]);

    const handlePlanReject = useCallback(() => {
      resolvePlanMode(sessionId, false);
    }, [resolvePlanMode, sessionId]);

    const handleQuestionSubmit = useCallback(
      (answers: (string | string[])[]) => {
        resolveQuestion(sessionId, answers);
      },
      [resolveQuestion, sessionId]
    );

    const handleQuestionDismiss = useCallback(() => {
      // Dismiss sends a cancellation sentinel so the agent can branch appropriately
      resolveQuestion(sessionId, ["USER_CANCELLED"]);
    }, [resolveQuestion, sessionId]);

    // Drop overlay shared between embedded and dialog layouts
    const dropOverlay = isDragging && (
      <div className="animate-drop-overlay-enter absolute inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
        <div className="border-border/60 bg-muted/80 flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed px-12 py-10 backdrop-blur-md">
          <Upload className="text-muted-foreground h-10 w-10" />
          <p className="text-foreground text-base font-medium">Add files</p>
          <p className="text-muted-foreground text-sm">
            Drop any files here to add them to your message
          </p>
        </div>
      </div>
    );

    // If embedded, render without overlay but with message input
    if (embedded) {
      return (
        <SessionProvider
          sessionStatus={sessionStatus}
          workspaceId={workspaceId ?? null}
          workspacePath={workspacePath}
          subagentMessages={subagentMessages}
        >
          <div
            className={`${CONTENT_WIDTH_CLASSES} relative flex min-h-0 flex-1 flex-col`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            {dropOverlay}

            <Chat
              messages={messages}
              loading={loading}
              sessionStatus={sessionStatus}
              errorMessage={session?.error_message}
              errorCategory={session?.error_category ?? undefined}
              agentHarness={session?.agent_harness}
              latestMessageSentAt={latestMessageSentAt}
              hasOlder={hasOlder}
              loadingOlder={loadOlderMutation.isPending}
              onLoadOlder={handleLoadOlder}
              onStop={() => composerRef.current?.stopSession()}
              onOpenLoginTerminal={workspaceId ? handleOpenLoginTerminal : undefined}
              onRetryInNewChat={handleRetryInNewChat}
              workspaceRepoName={workspaceRepoName}
              workspaceParentBranch={workspaceParentBranch}
              isFirstSession={isFirstSession}
              userSendCount={userSendCount}
            />

            {/* Agent-initiated interaction overlays — appear above the
                composer. Render only when session has loaded (overlays
                are irrelevant before that, and `agent_harness` is
                session-derived). */}
            {session && (
              <>
                <PlanApprovalOverlay
                  request={pendingPlan}
                  agentHarness={session.agent_harness}
                  onApprove={handlePlanApprove}
                  onReject={handlePlanReject}
                />
                <AgentQuestionOverlay
                  key={pendingQuestion?.wsRequestId}
                  request={pendingQuestion}
                  agentHarness={session.agent_harness}
                  onSubmit={handleQuestionSubmit}
                  onDismiss={handleQuestionDismiss}
                />
              </>
            )}

            <SessionComposer
              ref={composerRef}
              sessionId={sessionId}
              workspaceId={workspaceId}
              workspacePath={workspacePath}
              targetBranch={workspaceParentBranch ?? undefined}
              initialModel={initialModel}
              hasPendingPlan={!!pendingPlan}
              onOpenNewTab={onOpenNewTab}
              onAgentHarnessChange={onAgentHarnessChange}
              onSendComplete={handleSendComplete}
            />
          </div>
        </SessionProvider>
      );
    }

    const handleClose = () => {
      onClose?.();
    };

    return (
      <div
        className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/70"
        onClick={handleClose}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="workspace-activity-title"
          className="vibrancy-bg border-border/20 flex h-[90vh] w-[90%] max-w-[1200px] flex-col rounded-xl border shadow-[0_20px_60px_rgba(0,0,0,0.3)]"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="border-border/60 flex items-center justify-between border-b p-4">
            <h2 id="workspace-activity-title" className="text-foreground m-0 text-lg font-semibold">
              Workspace Activity
            </h2>
            <Button variant="ghost" size="icon" onClick={handleClose} title="Close">
              <X className="h-4 w-4" />
            </Button>
          </div>

          <div
            className="relative flex flex-1 overflow-hidden"
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            {dropOverlay}

            {/* Main Content Area */}
            <div className="flex min-h-0 flex-1 flex-col">
              <SessionProvider
                sessionStatus={sessionStatus}
                workspaceId={workspaceId ?? null}
                workspacePath={workspacePath}
                subagentMessages={subagentMessages}
              >
                <div className={`${CONTENT_WIDTH_CLASSES} mx-auto flex min-h-0 flex-1 flex-col`}>
                  <Chat
                    messages={messages}
                    loading={loading}
                    sessionStatus={sessionStatus}
                    errorMessage={session?.error_message}
                    errorCategory={session?.error_category ?? undefined}
                    agentHarness={session?.agent_harness}
                    latestMessageSentAt={latestMessageSentAt}
                    hasOlder={hasOlder}
                    loadingOlder={loadOlderMutation.isPending}
                    onLoadOlder={handleLoadOlder}
                    onStop={() => composerRef.current?.stopSession()}
                    onOpenLoginTerminal={workspaceId ? handleOpenLoginTerminal : undefined}
                    onRetryInNewChat={handleRetryInNewChat}
                    workspaceRepoName={workspaceRepoName}
                    workspaceParentBranch={workspaceParentBranch}
                    userSendCount={userSendCount}
                  />

                  {/* Agent-initiated interaction overlays — appear above the
                      composer. Render only when session has loaded. */}
                  {session && (
                    <>
                      <PlanApprovalOverlay
                        request={pendingPlan}
                        agentHarness={session.agent_harness}
                        onApprove={handlePlanApprove}
                        onReject={handlePlanReject}
                      />
                      <AgentQuestionOverlay
                        key={pendingQuestion?.wsRequestId}
                        request={pendingQuestion}
                        agentHarness={session.agent_harness}
                        onSubmit={handleQuestionSubmit}
                        onDismiss={handleQuestionDismiss}
                      />
                    </>
                  )}

                  <SessionComposer
                    ref={composerRef}
                    sessionId={sessionId}
                    workspaceId={workspaceId}
                    workspacePath={workspacePath}
                    targetBranch={workspaceParentBranch ?? undefined}
                    initialModel={initialModel}
                    showCompactButton={showCompactButton}
                    hasPendingPlan={!!pendingPlan}
                    onOpenNewTab={onOpenNewTab}
                    onAgentHarnessChange={onAgentHarnessChange}
                    onSendComplete={handleSendComplete}
                  />
                </div>
              </SessionProvider>
            </div>
          </div>
        </div>
      </div>
    );
  }
);

SessionPanel.displayName = "SessionPanel";
