import { useState, useEffect, useCallback, useRef, forwardRef, useImperativeHandle } from "react";
import { Chat, MessageInput } from ".";
import type { MessageInputRef } from ".";
import { useSocket } from "@/shared/hooks";
import { useSessionActions, useSessionEvents } from "../hooks";
import { SessionProvider } from "../context";
import { useSessionWithMessages, useLoadOlderMessages } from "../api/session.queries";
import { Button } from "@/components/ui/button";
import { X, Upload } from "lucide-react";
import {
  getRuntimeAgentTypeForModel,
  getRuntimeModelId,
  type RuntimeAgentType,
} from "../lib/agentRuntime";
import { isTauriEnv } from "@/platform/tauri";

const CONTENT_WIDTH_CLASSES = "w-full max-w-[960px] mx-auto min-w-0";

// Tauri native drag-drop: only accept formats the Anthropic vision API supports
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp)$/i;
const EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

interface SessionPanelProps {
  sessionId: string;
  workspacePath: string;
  onClose?: () => void;
  embedded?: boolean;
  onCompact?: (handler: () => void) => void;
  onCreatePR?: (handler: () => void) => void;
  onStop?: (handler: () => void) => void;
  onAgentTypeChange?: (agentType: RuntimeAgentType) => void;
  onSessionStarted?: () => void;
}

export interface SessionPanelRef {
  insertText: (text: string) => void;
}

export const SessionPanel = forwardRef<SessionPanelRef, SessionPanelProps>(
  (
    {
      sessionId,
      workspacePath,
      onClose,
      embedded = false,
      onCompact,
      onCreatePR,
      onStop,
      onAgentTypeChange,
      onSessionStarted,
    },
    ref
  ) => {
    // Custom hooks (useSocket manages socket connection lifecycle)
    useSocket();

    // Real-time message updates: Tauri events (desktop) + incremental polling (web)
    useSessionEvents(sessionId);

    // TanStack Query hooks
    const {
      messages,
      hasOlder,
      sessionStatus,
      latestMessageSentAt,
      loading,
      parseContent,
      toolResultMap,
      parentToolUseMap,
      subagentMessages,
    } = useSessionWithMessages(sessionId);

    // Load-older pagination
    const loadOlderMutation = useLoadOlderMessages();
    const handleLoadOlder = useCallback(() => {
      if (loadOlderMutation.isPending || !messages.length) return;
      const firstSeq = messages[0]?.seq;
      if (firstSeq == null) return;
      loadOlderMutation.mutate({ sessionId, beforeSeq: firstSeq });
    }, [loadOlderMutation, messages, sessionId]);

    // DEBUG: Log session data
    if (import.meta.env.DEV) {
      console.log("[SessionPanel] DEBUG:", {
        sessionId,
        messagesCount: messages.length,
        loading,
        sessionStatus,
        firstMessage: messages[0]?.id,
      });
    }

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

    // Tauri native drag-drop — WKWebView on macOS intercepts file drops from Finder
    // before JavaScript's dragover/drop events fire. Listen for Tauri's native event
    // to handle file drops in the desktop app.
    useEffect(() => {
      if (!isTauriEnv) return;

      let unlisten: (() => void) | undefined;
      let disposed = false;

      (async () => {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        const { readFile } = await import("@tauri-apps/plugin-fs");
        if (disposed) return;

        unlisten = await getCurrentWebview().onDragDropEvent(async (event) => {
          const { type } = event.payload;

          if (type === "enter") {
            // Only show overlay if at least one file looks like an image
            const hasImage = event.payload.paths.some((p) => IMAGE_EXTENSIONS.test(p));
            if (hasImage) setIsDragging(true);
          } else if (type === "over") {
            // Keep overlay visible while hovering
          } else if (type === "leave") {
            setIsDragging(false);
          } else if (type === "drop") {
            setIsDragging(false);

            const imagePaths = event.payload.paths.filter((p) => IMAGE_EXTENSIONS.test(p));
            if (!imagePaths.length) return;

            const files: File[] = [];
            for (const filePath of imagePaths) {
              try {
                const data = await readFile(filePath);
                const name = filePath.split("/").pop() || "image.png";
                const ext = name.split(".").pop()?.toLowerCase() || "png";
                const mime = EXT_TO_MIME[ext] || "image/png";
                files.push(new File([data], name, { type: mime }));
              } catch (err) {
                console.error("[SessionPanel] Failed to read dropped file:", filePath, err);
              }
            }

            if (files.length > 0) {
              messageInputRef.current?.addFiles(files);
            }
          }
        });
        // If unmounted while awaiting onDragDropEvent, clean up immediately
        if (disposed) {
          unlisten?.();
        }
      })();

      return () => {
        disposed = true;
        unlisten?.();
      };
    }, []);

    // Local state for message input
    const [messageInput, setMessageInput] = useState("");
    const [thinkingLevel, setThinkingLevel] = useState("NONE");
    const [model, setModel] = useState("sonnet");
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

    const handleAttachmentClick = () => {
      // TODO: Implement file picker dialog
    };

    // TODO: Fetch MCP servers from settings/API
    const mcpServers: { name: string; active: boolean; command: string }[] = [];

    // Show compact button when there are enough messages to benefit from compacting
    const showCompactButton = messages.length > 10;

    // Context token count placeholder — not tracked in DB, always 0 for now
    const contextTokenCount = 0;

    // Session actions using custom hook
    const { sendMessage, stopSession, compactConversation, createPR, sending } = useSessionActions({
      sessionId,
      workspacePath,
      messageInput,
      model: runtimeModelId,
      agentType: modelAgentType,
      onMessageSent: () => {
        setMessageInput("");
        messageInputRef.current?.clearPastedContent();
        onSessionStarted?.();
      },
    });

    // Expose action handlers to parent
    useEffect(() => {
      onCompact?.(compactConversation);
      onCreatePR?.(createPR);
      onStop?.(stopSession);
    }, [compactConversation, createPR, stopSession, onCompact, onCreatePR, onStop]);

    // Expose insertText method for browser element selector
    useImperativeHandle(
      ref,
      () => ({
        insertText: (text: string) => {
          // Add with double newline for proper formatting
          setMessageInput((prev) => {
            const separator = prev.trim() ? "\n\n" : "";
            return prev + separator + text;
          });
        },
      }),
      [setMessageInput]
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
          sessionStatus={sessionStatus}
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
              latestMessageSentAt={latestMessageSentAt}
              hasOlder={hasOlder}
              loadingOlder={loadOlderMutation.isPending}
              onLoadOlder={handleLoadOlder}
              onStop={stopSession}
            />

            {/* Fade overlay: smoothly transitions chat scroll area into input */}
            <div className="bg-fade-overlay pointer-events-none relative z-10 -mb-8 h-8 shrink-0" />

            <MessageInput
              ref={messageInputRef}
              messageInput={messageInput}
              sending={sending}
              sessionStatus={sessionStatus}
              embedded={true}
              model={model}
              thinkingLevel={thinkingLevel}
              mcpServers={mcpServers}
              contextTokenCount={contextTokenCount}
              onMessageChange={setMessageInput}
              onSend={(content) => sendMessage(content)}
              onStop={stopSession}
              onModelChange={handleModelChange}
              onThinkingLevelChange={handleThinkingLevelChange}
              onAttachmentClick={handleAttachmentClick}
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
                sessionStatus={sessionStatus}
              >
                <div className={`${CONTENT_WIDTH_CLASSES} mx-auto flex min-h-0 flex-1 flex-col`}>
                  <Chat
                    messages={messages}
                    loading={loading}
                    sessionStatus={sessionStatus}
                    latestMessageSentAt={latestMessageSentAt}
                    hasOlder={hasOlder}
                    loadingOlder={loadOlderMutation.isPending}
                    onLoadOlder={handleLoadOlder}
                    onStop={stopSession}
                  />

                  {/* Fade overlay: smoothly transitions chat scroll area into input */}
                  <div className="bg-fade-overlay pointer-events-none relative z-10 -mb-8 h-8 shrink-0" />

                  <MessageInput
                    ref={messageInputRef}
                    messageInput={messageInput}
                    sending={sending}
                    sessionStatus={sessionStatus}
                    embedded={false}
                    model={model}
                    thinkingLevel={thinkingLevel}
                    showCompactButton={showCompactButton}
                    mcpServers={mcpServers}
                    contextTokenCount={contextTokenCount}
                    onMessageChange={setMessageInput}
                    onSend={(content) => sendMessage(content)}
                    onCompact={compactConversation}
                    onCreatePR={createPR}
                    onStop={stopSession}
                    onModelChange={handleModelChange}
                    onThinkingLevelChange={handleThinkingLevelChange}
                    onAttachmentClick={handleAttachmentClick}
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
