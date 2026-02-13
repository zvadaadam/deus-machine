/**
 * Chat Area — owns chat tab management, keyboard shortcuts, and session rendering.
 *
 * Supports chat and file tabs only. Diff viewing is handled by MainContent
 * as a side panel (horizontal split), visible simultaneously with chat.
 *
 * Exposes openFileTab via ref for file browser integration.
 */

import { useState, useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from "react";
import { SessionPanel } from "@/features/session";
import type { SessionPanelRef } from "@/features/session";
import { MainContentTabBar } from "@/features/workspace";
import { FileViewer } from "@/features/file-browser";
import type { Workspace } from "@/shared/types";
import type { Tab } from "@/features/workspace/ui/MainContentTabs";

/** Imperative methods exposed to parent via ref */
export interface ChatAreaRef {
  openFileTab: (filePath: string) => void;
}

interface ChatAreaProps {
  workspace: Workspace;
  workspaceChatPanelRef: React.MutableRefObject<SessionPanelRef | null>;
  onCreatePRHandlerChange: (handler: (() => void) | null) => void;
  onCollapseChatPanel?: () => void;
}

export const ChatArea = forwardRef<ChatAreaRef, ChatAreaProps>(function ChatArea(
  { workspace, workspaceChatPanelRef, onCreatePRHandlerChange, onCollapseChatPanel },
  ref
) {
  // Tab state — chat + file tabs only
  const [mainTabs, setMainTabs] = useState<Tab[]>([
    { id: "chat-1", label: "Chat #1", type: "chat", closeable: false },
  ]);
  const [activeMainTabId, setActiveMainTabId] = useState("chat-1");
  const nextChatIndexRef = useRef(2);

  // --- Tab handlers ---

  const handleMainTabChange = (tabId: string) => setActiveMainTabId(tabId);

  const handleMainTabClose = useCallback(
    (tabId: string) => {
      setMainTabs((prev) => {
        const currentIndex = prev.findIndex((t) => t.id === tabId);
        const newTabs = prev.filter((t) => t.id !== tabId);
        if (tabId === activeMainTabId && newTabs.length > 0) {
          const targetIndex = currentIndex > 0 ? currentIndex - 1 : 0;
          setActiveMainTabId(newTabs[targetIndex].id);
        }
        return newTabs;
      });
    },
    [activeMainTabId]
  );

  const handleMainTabAdd = useCallback(() => {
    const idx = nextChatIndexRef.current++;
    const newId = `chat-${idx}`;
    const newTab: Tab = {
      id: newId,
      label: `Chat #${idx}`,
      type: "chat",
      closeable: true,
    };
    setMainTabs((prevTabs) => [...prevTabs, newTab]);
    setActiveMainTabId(newId);
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

  // Cmd+T shortcut to open new chat tab
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "t") {
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
  }, [handleMainTabAdd]);

  // --- Render ---

  const activeTab = mainTabs.find((t) => t.id === activeMainTabId);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      <MainContentTabBar
        tabs={mainTabs}
        activeTabId={activeMainTabId}
        onTabChange={handleMainTabChange}
        onTabClose={handleMainTabClose}
        onTabAdd={handleMainTabAdd}
        onCollapseChatPanel={onCollapseChatPanel}
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Chat tab — SessionPanel */}
        {activeTab?.type === "chat" && workspace.active_session_id && (
          <SessionPanel
            ref={workspaceChatPanelRef}
            sessionId={workspace.active_session_id}
            workspacePath={workspace.workspace_path}
            embedded={true}
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
