/**
 * Chat Area — owns tab management, keyboard shortcuts, and content rendering.
 *
 * Supports three tab types:
 * - "chat": SessionPanel (AI chat)
 * - "diff": DiffTabContent (self-contained diff viewer)
 * - "file": FileViewer (full file content)
 *
 * Exposes openDiffTab/openFileTab via ref so external components
 * (RightSidePanel → MainContent) can trigger tab creation.
 */

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  forwardRef,
  useImperativeHandle,
} from "react";
import { SessionPanel } from "@/features/session";
import type { SessionPanelRef } from "@/features/session";
import { MainContentTabBar, DiffTabContent } from "@/features/workspace";
import { FileViewer } from "@/features/file-browser";
import type { Workspace } from "@/shared/types";
import type { Tab } from "@/features/workspace/ui/MainContentTabs";
import type { WorkspaceGitInfo } from "@/features/workspace/api/workspace.service";

/** Imperative methods exposed to parent via ref */
export interface ChatAreaRef {
  openDiffTab: (filePath: string) => void;
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
  // Tab state
  const [mainTabs, setMainTabs] = useState<Tab[]>([
    { id: "chat-1", label: "Chat #1", type: "chat", closeable: false },
  ]);
  const [activeMainTabId, setActiveMainTabId] = useState("chat-1");
  const nextChatIndexRef = useRef(2);

  // WorkspaceGitInfo for Tauri IPC diff fetching
  const workspaceGitInfo: WorkspaceGitInfo = useMemo(
    () => ({
      root_path: workspace.root_path,
      directory_name: workspace.directory_name,
    }),
    [workspace.root_path, workspace.directory_name]
  );

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

  // --- Imperative methods for opening diff/file tabs ---

  const openDiffTab = useCallback((filePath: string) => {
    const tabId = `diff-${filePath}`;
    setMainTabs((prev) => {
      // If tab already exists, just switch to it
      if (prev.some((t) => t.id === tabId)) {
        setActiveMainTabId(tabId);
        return prev;
      }
      // Create new diff tab
      const fileName = filePath.split("/").pop() || filePath;
      const newTab: Tab = {
        id: tabId,
        label: fileName,
        type: "diff",
        closeable: true,
        data: { filePath },
      };
      setActiveMainTabId(tabId);
      return [...prev, newTab];
    });
  }, []);

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

  useImperativeHandle(ref, () => ({ openDiffTab, openFileTab }), [openDiffTab, openFileTab]);

  // --- Keyboard shortcuts ---

  const handleBranchRename = (newName: string) => {
    if (import.meta.env.DEV) console.log("Branch rename:", workspace.branch, "->", newName);
  };

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
        repositoryName={workspace.root_path.split("/").filter(Boolean).pop()}
        branch={workspace.branch}
        workspacePath={workspace.workspace_path}
        onBranchRename={handleBranchRename}
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Chat tab — SessionPanel */}
        {activeTab?.type === "chat" && workspace.active_session_id && (
          <SessionPanel
            ref={workspaceChatPanelRef}
            sessionId={workspace.active_session_id}
            workspacePath={workspace.workspace_path}
            embedded={true}
            onCreatePR={(handler) => onCreatePRHandlerChange(handler)}
          />
        )}

        {/* Diff tab — self-contained diff fetcher */}
        {activeTab?.type === "diff" && activeTab.data?.filePath && (
          <DiffTabContent
            workspaceId={workspace.id}
            filePath={activeTab.data.filePath}
            workspaceGitInfo={workspaceGitInfo}
            onClose={() => handleMainTabClose(activeTab.id)}
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
