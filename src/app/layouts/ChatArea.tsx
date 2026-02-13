/**
 * Chat Area — owns chat tab management, keyboard shortcuts, and session rendering.
 *
 * Each chat tab owns a real DB session. New tabs create sessions via
 * POST /workspaces/:id/sessions. The first tab uses the workspace's
 * existing active_session_id for backward compatibility.
 *
 * Supports chat and file tabs only. Diff viewing is handled by MainContent
 * as a side panel (horizontal split), visible simultaneously with chat.
 *
 * Exposes openFileTab via ref for file browser integration.
 */

import { useState, useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from "react";
import { toast } from "sonner";
import { SessionPanel } from "@/features/session";
import type { SessionPanelRef } from "@/features/session";
import { useCreateSession } from "@/features/session/api/session.queries";
import { getRuntimeAgentLabel, type RuntimeAgentType } from "@/features/session/lib/agentRuntime";
import { MainContentTabBar } from "@/features/workspace";
import { FileViewer } from "@/features/file-browser";
import type { Workspace } from "@/shared/types";
import type { Tab, ClosedTab } from "@/features/workspace/ui/MainContentTabs";

const NEW_CHAT_LABEL = "New chat";
const MAX_CLOSED_TABS = 20;

function buildStartedChatLabel(agentType: string, sequence: number): string {
  return `${getRuntimeAgentLabel(agentType)} #${sequence}`;
}

/** Imperative methods exposed to parent via ref */
export interface ChatAreaRef {
  openFileTab: (filePath: string) => void;
}

interface ChatAreaProps {
  workspace: Workspace;
  workspaceChatPanelRef: React.MutableRefObject<SessionPanelRef | null>;
  onCreatePRHandlerChange: (handler: (() => void) | null) => void;
}

export const ChatArea = forwardRef<ChatAreaRef, ChatAreaProps>(function ChatArea(
  { workspace, workspaceChatPanelRef, onCreatePRHandlerChange },
  ref
) {
  // Tab state — chat + file tabs only
  // First tab uses workspace.active_session_id via data.sessionId
  const [mainTabs, setMainTabs] = useState<Tab[]>([
    {
      id: "chat-1",
      label: NEW_CHAT_LABEL,
      type: "chat",
      data: {
        sessionId: workspace.active_session_id ?? undefined,
        agentType: "claude",
        hasStarted: false,
      },
    },
  ]);
  const [activeMainTabId, setActiveMainTabId] = useState("chat-1");
  const [closedTabs, setClosedTabs] = useState<ClosedTab[]>([]);
  const nextChatIndexRef = useRef(2);

  const createSessionMutation = useCreateSession();

  // --- Tab handlers ---

  const handleMainTabChange = (tabId: string) => setActiveMainTabId(tabId);

  const handleMainTabClose = useCallback(
    (tabId: string) => {
      setMainTabs((prev) => {
        // Never close the last tab
        if (prev.length <= 1) return prev;

        const closingTab = prev.find((t) => t.id === tabId);
        const currentIndex = prev.findIndex((t) => t.id === tabId);
        const newTabs = prev.filter((t) => t.id !== tabId);

        // Save closed chat tab for restore
        if (closingTab?.type === "chat" && closingTab.data?.sessionId) {
          setClosedTabs((prevClosed) => {
            const entry: ClosedTab = {
              label: closingTab.label,
              sessionId: closingTab.data!.sessionId!,
              agentType: closingTab.data?.agentType,
              closedAt: Date.now(),
            };
            // Prepend and cap at MAX_CLOSED_TABS
            return [entry, ...prevClosed].slice(0, MAX_CLOSED_TABS);
          });
        }

        if (tabId === activeMainTabId && newTabs.length > 0) {
          const targetIndex = currentIndex > 0 ? currentIndex - 1 : 0;
          setActiveMainTabId(newTabs[targetIndex].id);
        }
        return newTabs;
      });
    },
    [activeMainTabId]
  );

  const handleMainTabAdd = useCallback(async () => {
    const idx = nextChatIndexRef.current++;
    const newId = `chat-${idx}`;

    try {
      // Create a real DB session for this tab
      const newSession = await createSessionMutation.mutateAsync(workspace.id);
      const newTab: Tab = {
        id: newId,
        label: NEW_CHAT_LABEL,
        type: "chat",
        data: { sessionId: newSession.id, agentType: "claude", hasStarted: false },
      };
      setMainTabs((prevTabs) => [...prevTabs, newTab]);
      setActiveMainTabId(newId);
    } catch (error) {
      console.error("[ChatArea] Failed to create new session:", error);
      toast.error("Failed to create new chat session");
      nextChatIndexRef.current--;
    }
  }, [workspace.id, createSessionMutation]);

  /** Restore a previously closed chat tab using its existing session */
  const handleTabRestore = useCallback((closedTab: ClosedTab) => {
    const idx = nextChatIndexRef.current++;
    const newId = `chat-${idx}`;

    const restoredTab: Tab = {
      id: newId,
      label: closedTab.label,
      type: "chat",
      data: {
        sessionId: closedTab.sessionId,
        agentType: closedTab.agentType,
        // Mark as started if it had a label other than "New chat"
        hasStarted: closedTab.label !== NEW_CHAT_LABEL,
      },
    };

    setMainTabs((prev) => [...prev, restoredTab]);
    setActiveMainTabId(newId);

    // Remove from closed list
    setClosedTabs((prev) => prev.filter((ct) => ct.sessionId !== closedTab.sessionId));
  }, []);

  const updateChatTabAgentType = useCallback((tabId: string, nextAgentType: RuntimeAgentType) => {
    setMainTabs((prevTabs) => {
      const tabIndex = prevTabs.findIndex((tab) => tab.id === tabId);
      if (tabIndex === -1) return prevTabs;

      const tab = prevTabs[tabIndex];
      if (tab.type !== "chat") return prevTabs;
      if (tab.data?.agentType === nextAgentType) return prevTabs;

      const hasStarted = Boolean(tab.data?.hasStarted);

      let nextLabel = hasStarted ? tab.label : NEW_CHAT_LABEL;
      let nextSequence = tab.data?.agentSequence;

      if (hasStarted) {
        const taken = prevTabs.filter(
          (candidate) =>
            candidate.id !== tabId &&
            candidate.type === "chat" &&
            candidate.data?.hasStarted &&
            candidate.data?.agentType === nextAgentType
        ).length;
        nextSequence = taken + 1;
        nextLabel = buildStartedChatLabel(nextAgentType, nextSequence);
      }

      const updatedTabs = [...prevTabs];
      updatedTabs[tabIndex] = {
        ...tab,
        label: nextLabel,
        data: {
          ...tab.data,
          agentType: nextAgentType,
          hasStarted,
          agentSequence: nextSequence,
        },
      };
      return updatedTabs;
    });
  }, []);

  const markChatTabStarted = useCallback((tabId: string) => {
    setMainTabs((prevTabs) => {
      const tabIndex = prevTabs.findIndex((tab) => tab.id === tabId);
      if (tabIndex === -1) return prevTabs;

      const tab = prevTabs[tabIndex];
      if (tab.type !== "chat" || tab.data?.hasStarted) return prevTabs;

      const agentType = (tab.data?.agentType as RuntimeAgentType | undefined) ?? "claude";
      const taken = prevTabs.filter(
        (candidate) =>
          candidate.id !== tabId &&
          candidate.type === "chat" &&
          candidate.data?.hasStarted &&
          candidate.data?.agentType === agentType
      ).length;
      const nextSequence = taken + 1;

      const updatedTabs = [...prevTabs];
      updatedTabs[tabIndex] = {
        ...tab,
        label: buildStartedChatLabel(agentType, nextSequence),
        data: {
          ...tab.data,
          agentType,
          hasStarted: true,
          agentSequence: nextSequence,
        },
      };
      return updatedTabs;
    });
  }, []);

  // --- Imperative method for opening file tabs ---

  const openFileTab = useCallback((filePath: string) => {
    const tabId = `file-${filePath}`;
    setMainTabs((prev) => {
      if (prev.some((t) => t.id === tabId)) {
        setActiveMainTabId(tabId);
        return prev;
      }
      const fileName = filePath.split("/").pop() || filePath;
      const newTab: Tab = {
        id: tabId,
        label: fileName,
        type: "file",
        closeable: true,
        data: { filePath },
      };
      setActiveMainTabId(tabId);
      return [...prev, newTab];
    });
  }, []);

  useImperativeHandle(ref, () => ({ openFileTab }), [openFileTab]);

  // --- Keyboard shortcuts ---

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const isModKey = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();

      // Cmd+Shift+T — restore last closed tab (check before Cmd+T)
      if (isModKey && e.shiftKey && key === "t") {
        e.preventDefault();
        setClosedTabs((prev) => {
          if (prev.length === 0) return prev;
          const [latest, ...rest] = prev;
          // Defer restore to avoid state conflicts inside setClosedTabs
          queueMicrotask(() => handleTabRestore(latest));
          return rest;
        });
        return;
      }

      // Cmd+T — new chat tab
      if (isModKey && key === "t") {
        const ae = document.activeElement as HTMLElement | null;
        const isTextField =
          !!ae &&
          (ae.tagName === "INPUT" ||
            ae.tagName === "TEXTAREA" ||
            ae.isContentEditable ||
            ae.getAttribute("role") === "textbox");
        if (isTextField) return;

        e.preventDefault();
        handleMainTabAdd();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleMainTabAdd, handleTabRestore]);

  // --- Render ---

  const activeTab = mainTabs.find((t) => t.id === activeMainTabId);

  // Resolve sessionId: tab's own session, falling back to workspace's active session
  const tabSessionId =
    activeTab?.type === "chat" ? activeTab.data?.sessionId || workspace.active_session_id : null;

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      <MainContentTabBar
        tabs={mainTabs}
        activeTabId={activeMainTabId}
        onTabChange={handleMainTabChange}
        onTabClose={handleMainTabClose}
        onTabAdd={handleMainTabAdd}
        closedTabs={closedTabs}
        onTabRestore={handleTabRestore}
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Chat tab — SessionPanel with tab-specific sessionId */}
        {activeTab?.type === "chat" && tabSessionId && (
          <SessionPanel
            ref={workspaceChatPanelRef}
            sessionId={tabSessionId}
            workspacePath={workspace.workspace_path}
            embedded={true}
            onAgentTypeChange={(agentType) => updateChatTabAgentType(activeTab.id, agentType)}
            onSessionStarted={() => markChatTabStarted(activeTab.id)}
            // Wrap in `() =>` so React stores handler as state, not call it as updater
            onCreatePR={(handler) => onCreatePRHandlerChange(() => handler)}
          />
        )}

        {/* File tab — full file viewer */}
        {activeTab?.type === "file" && activeTab.data?.filePath && (
          <FileViewer filePath={activeTab.data.filePath} />
        )}
      </div>
    </div>
  );
});
