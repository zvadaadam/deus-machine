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
import { MessageInput } from "./MessageInput";
import type { MessageInputRef } from "./MessageInput";
import { useSessionActions } from "../hooks";
import { useAgentRpcHandler } from "../hooks/useAgentRpcHandler";
import { SessionProvider } from "../context";
import { useSessionWithMessages, useLoadOlderMessages } from "../api/session.queries";
import { useManifestTasks } from "@/features/workspace/api/workspace.queries";
import { PlanApprovalOverlay } from "./PlanApprovalOverlay";
import { AgentQuestionOverlay } from "./AgentQuestionOverlay";
import { BlockRenderer } from "./blocks/BlockRenderer";
import { Button } from "@/components/ui/button";
import { X, Upload } from "lucide-react";
import {
  getRuntimeAgentTypeForModel,
  getRuntimeModelId,
  type RuntimeAgentType,
} from "../lib/agentRuntime";
import { workspaceLayoutActions } from "@/features/workspace/store";
import type { InspectedElement } from "./InspectedElementCard";
import type { ContentBlock, MessageRole } from "../types";

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
  onAgentTypeChange?: (agentType: RuntimeAgentType) => void;
  onSessionStarted?: () => void;
  /** Opens a new chat tab with the given model pre-selected */
  onOpenNewTab?: (initialModel?: string) => void;
  /** Model to pre-select when this tab was created from the locked-group picker */
  initialModel?: string;
}

export interface SessionPanelRef {
  insertText: (text: string) => void;
  addInspectedElement: (element: Omit<InspectedElement, "id">) => void;
  addFiles: (files: File[]) => void;
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
      onAgentTypeChange,
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
      messages,
      hasOlder,
      sessionStatus,
      latestMessageSentAt,
      loading,
      parseContent,
      toolResultMap,
      parentToolUseMap,
      subagentMessages,
      partsMap,
    } = useSessionWithMessages(sessionId);

    // Load-older pagination
    const loadOlderMutation = useLoadOlderMessages();
    const handleLoadOlder = useCallback(() => {
      if (loadOlderMutation.isPending || !messages.length) return;
      const firstSeq = messages[0]?.seq;
      if (firstSeq == null) return;
      loadOlderMutation.mutate({ sessionId, beforeSeq: firstSeq });
    }, [loadOlderMutation, messages, sessionId]);

    // DEBUG: disabled — was flooding console, making [autoscroll] logs unreadable
    // if (import.meta.env.DEV) {
    //   console.log("[SessionPanel] DEBUG:", { sessionId, messagesCount: messages.length, loading, sessionStatus });
    // }

    // Ref to MessageInput for adding files from panel-level drag & drop
    const messageInputRef = useRef<MessageInputRef>(null);

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

    const handleDrop = useCallback((e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) {
        messageInputRef.current?.addFiles(files);
      }
    }, []);

    // Native drag-drop — Electron handles file drops via standard HTML5 drag-drop
    // events. The renderer has full access to File objects from the drop event,
    // so no special IPC is needed.
    // Standard HTML5 drag-drop is handled by MessageInput's existing drop handler.

    // Local state for message input
    const [messageInput, setMessageInput] = useState("");
    const [thinkingLevel, setThinkingLevel] = useState("NONE");
    const [model, setModel] = useState(initialModel ?? "opus");
    const [planModeEnabled, setPlanModeEnabled] = useState(false);
    // Counter incremented when the human clicks Send — triggers auto-scroll resume
    const [userSendCount, setUserSendCount] = useState(0);
    const runtimeModelId = getRuntimeModelId(model);
    const modelAgentType: RuntimeAgentType = getRuntimeAgentTypeForModel(model);

    // Handlers for MessageInput controls
    const handleModelChange = (newModel: string) => {
      setModel(newModel);
      // TODO: Implement API call to update session model
    };

    useEffect(() => {
      onAgentTypeChange?.(getRuntimeAgentTypeForModel(model));
    }, [model, onAgentTypeChange]);

    const handleThinkingLevelChange = (level: string) => {
      setThinkingLevel(level);
      // TODO: Implement API call to update session thinking level
    };

    // Manifest status — cache-only read (staleTime: Infinity, already fetched by MainContent)
    // Default to true while loading to prevent the setup nudge from flashing briefly
    const { data: manifestData } = useManifestTasks(workspaceId ?? null);
    const hasManifest = manifestData === undefined ? true : manifestData?.manifest != null;

    // Show compact button when there are enough messages to benefit from compacting
    const showCompactButton = messages.length > 10;

    // Session actions using custom hook
    const { sendMessage, stopSession, compactConversation, createPR, sending } = useSessionActions({
      sessionId,
      workspaceId,
      messageInput,
      model: runtimeModelId,
      agentType: modelAgentType,
      permissionMode: planModeEnabled ? "plan" : undefined,
      targetBranch: workspaceParentBranch ?? "main",
      onMessageSent: () => {
        setMessageInput("");
        messageInputRef.current?.clearPastedContent();
        setUserSendCount((c) => c + 1);
        onSessionStarted?.();
      },
    });

    // Expose action handlers to parent
    useEffect(() => {
      onCompact?.(compactConversation);
      onCreatePR?.(createPR);
      onSendAgentMessage?.(sendMessage);
      onStop?.(stopSession);
    }, [
      compactConversation,
      createPR,
      sendMessage,
      stopSession,
      onCompact,
      onCreatePR,
      onSendAgentMessage,
      onStop,
    ]);

    // Expose imperative methods for browser element selector and text insertion
    useImperativeHandle(
      ref,
      () => ({
        insertText: (text: string) => {
          setMessageInput((prev) => {
            const separator = prev.trim() ? "\n\n" : "";
            return prev + separator + text;
          });
        },
        addInspectedElement: (element: Omit<InspectedElement, "id">) => {
          messageInputRef.current?.addInspectedElement(element);
        },
        addFiles: (files: File[]) => {
          messageInputRef.current?.addFiles(files);
        },
        sendMessage: (content: string, modelOverride?: string) => {
          if (modelOverride) setModel(modelOverride);
          return sendMessage(content);
        },
      }),
      [setMessageInput, sendMessage]
    );

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

    // Stable renderBlock callback injected into SessionContext to break the circular import:
    // BlockRenderer → ToolUseBlock → SubagentGroupBlock → SubagentMessageList → BlockRenderer
    const renderBlock = useCallback(
      (block: ContentBlock | string, index: number, role?: MessageRole, isStreaming?: boolean) => (
        <BlockRenderer block={block} index={index} role={role} isStreaming={isStreaming} />
      ),
      []
    );

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
          parseContent={parseContent}
          toolResultMap={toolResultMap}
          parentToolUseMap={parentToolUseMap}
          subagentMessages={subagentMessages}
          partsMap={partsMap}
          sessionStatus={sessionStatus}
          renderBlock={renderBlock}
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
              agentType={session?.agent_type}
              latestMessageSentAt={latestMessageSentAt}
              hasOlder={hasOlder}
              loadingOlder={loadOlderMutation.isPending}
              onLoadOlder={handleLoadOlder}
              onStop={stopSession}
              onOpenLoginTerminal={workspaceId ? handleOpenLoginTerminal : undefined}
              onRetryInNewChat={handleRetryInNewChat}
              workspaceRepoName={workspaceRepoName}
              workspaceParentBranch={workspaceParentBranch}
              isFirstSession={isFirstSession}
              userSendCount={userSendCount}
            />

            {/* Agent-initiated interaction overlays — appear above MessageInput */}
            <PlanApprovalOverlay
              request={pendingPlan}
              agentType={session?.agent_type}
              onApprove={handlePlanApprove}
              onReject={handlePlanReject}
            />
            <AgentQuestionOverlay
              key={pendingQuestion?.wsRequestId}
              request={pendingQuestion}
              agentType={session?.agent_type}
              onSubmit={handleQuestionSubmit}
              onDismiss={handleQuestionDismiss}
            />

            <MessageInput
              ref={messageInputRef}
              messageInput={messageInput}
              sending={sending}
              sessionStatus={sessionStatus}
              model={model}
              thinkingLevel={thinkingLevel}
              contextTokenCount={session?.context_token_count ?? 0}
              contextUsedPercent={session?.context_used_percent ?? 0}
              workspacePath={workspacePath}
              workspaceId={workspaceId}
              hasMessages={messages.length > 0}
              hasManifest={hasManifest}
              onMessageChange={setMessageInput}
              onSend={(content) => sendMessage(content)}
              onStop={stopSession}
              onModelChange={handleModelChange}
              onOpenNewTab={onOpenNewTab}
              onThinkingLevelChange={handleThinkingLevelChange}
              planModeEnabled={planModeEnabled}
              onPlanModeToggle={() => setPlanModeEnabled((p) => !p)}
              planModeDisabled={modelAgentType === "codex"}
              hasPendingPlan={!!pendingPlan}
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
                parseContent={parseContent}
                toolResultMap={toolResultMap}
                parentToolUseMap={parentToolUseMap}
                subagentMessages={subagentMessages}
                partsMap={partsMap}
                sessionStatus={sessionStatus}
                renderBlock={renderBlock}
              >
                <div className={`${CONTENT_WIDTH_CLASSES} mx-auto flex min-h-0 flex-1 flex-col`}>
                  <Chat
                    messages={messages}
                    loading={loading}
                    sessionStatus={sessionStatus}
                    errorMessage={session?.error_message}
                    errorCategory={session?.error_category ?? undefined}
                    agentType={session?.agent_type}
                    latestMessageSentAt={latestMessageSentAt}
                    hasOlder={hasOlder}
                    loadingOlder={loadOlderMutation.isPending}
                    onLoadOlder={handleLoadOlder}
                    onStop={stopSession}
                    onOpenLoginTerminal={workspaceId ? handleOpenLoginTerminal : undefined}
                    onRetryInNewChat={handleRetryInNewChat}
                    workspaceRepoName={workspaceRepoName}
                    workspaceParentBranch={workspaceParentBranch}
                    userSendCount={userSendCount}
                  />

                  {/* Agent-initiated interaction overlays — appear above MessageInput */}
                  <PlanApprovalOverlay
                    request={pendingPlan}
                    agentType={session?.agent_type}
                    onApprove={handlePlanApprove}
                    onReject={handlePlanReject}
                  />
                  <AgentQuestionOverlay
                    key={pendingQuestion?.wsRequestId}
                    request={pendingQuestion}
                    agentType={session?.agent_type}
                    onSubmit={handleQuestionSubmit}
                    onDismiss={handleQuestionDismiss}
                  />

                  <MessageInput
                    ref={messageInputRef}
                    messageInput={messageInput}
                    sending={sending}
                    sessionStatus={sessionStatus}
                    model={model}
                    thinkingLevel={thinkingLevel}
                    showCompactButton={showCompactButton}
                    contextTokenCount={session?.context_token_count ?? 0}
                    contextUsedPercent={session?.context_used_percent ?? 0}
                    workspacePath={workspacePath}
                    workspaceId={workspaceId}
                    hasMessages={messages.length > 0}
                    hasManifest={hasManifest}
                    onMessageChange={setMessageInput}
                    onSend={(content) => sendMessage(content)}
                    onCompact={compactConversation}
                    onStop={stopSession}
                    onModelChange={handleModelChange}
                    onOpenNewTab={onOpenNewTab}
                    onThinkingLevelChange={handleThinkingLevelChange}
                    planModeEnabled={planModeEnabled}
                    onPlanModeToggle={() => setPlanModeEnabled((p) => !p)}
                    planModeDisabled={modelAgentType === "codex"}
                    hasPendingPlan={!!pendingPlan}
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
