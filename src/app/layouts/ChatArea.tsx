/**
 * Chat Area — owns tab management, keyboard shortcuts, and content rendering.
 *
 * Supports chat, file, and diff tabs. Diff tabs open when user clicks a
 * changed file in the right panel (VS Code pattern: diff in editor area,
 * file list stays in sidebar).
 *
 * Exposes openFileTab and openDiffTab via ref for integration with RightSidePanel.
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
import { MainContentTabBar } from "@/features/workspace";
import { DiffTabContent } from "@/features/workspace/ui/DiffTabContent";
import { FileViewer } from "@/features/file-browser";
import type { WorkspaceGitInfo } from "@/features/workspace";
import type { Workspace } from "@/shared/types";
import type { Tab } from "@/features/workspace/ui/MainContentTabs";

/** Imperative methods exposed to parent via ref */
export interface ChatAreaRef {
  openFileTab: (filePath: string) => void;
  openDiffTab: (filePath: string) => void;
}

interface ChatAreaProps {
  workspace: Workspace;
  workspaceChatPanelRef: React.MutableRefObject<SessionPanelRef | null>;
  onCreatePRHandlerChange: (handler: (() => void) | null) => void;
  /** Notifies parent when active tab type changes to/from "diff" (for resize handle) */
  onDiffTabActiveChange?: (isActive: boolean) => void;
}

export const ChatArea = forwardRef<ChatAreaRef, ChatAreaProps>(function ChatArea(
  { workspace, workspaceChatPanelRef, onCreatePRHandlerChange, onDiffTabActiveChange },
  ref
) {
  // Tab state — chat + file + diff tabs
  const [mainTabs, setMainTabs] = useState<Tab[]>([
    { id: "chat-1", label: "Chat #1", type: "chat", closeable: false },
  ]);
  const [activeMainTabId, setActiveMainTabId] = useState("chat-1");
  const nextChatIndexRef = useRef(2);

  // Workspace git info for diff tab queries
  const workspaceGitInfo: WorkspaceGitInfo = useMemo(
    () => ({
      root_path: workspace.root_path,
      directory_name: workspace.directory_name,
    }),
    [workspace.root_path, workspace.directory_name]
  );

  // --- Notify parent when active tab is a diff tab ---
  const activeTab = mainTabs.find((t) => t.id === activeMainTabId);
  const isDiffTabActive = activeTab?.type === "diff";

  useEffect(() => {
    onDiffTabActiveChange?.(isDiffTabActive);
  }, [isDiffTabActive, onDiffTabActiveChange]);

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

  // --- Imperative methods for opening tabs ---

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

  const openDiffTab = useCallback((filePath: string) => {
    const tabId = `diff-${filePath}`;
    setMainTabs((prev) => {
      if (prev.some((t) => t.id === tabId)) {
        setActiveMainTabId(tabId);
        return prev;
      }
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

  useImperativeHandle(ref, () => ({ openFileTab, openDiffTab }), [openFileTab, openDiffTab]);

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

        {/* File tab — full file viewer */}
        {activeTab?.type === "file" && activeTab.data?.filePath && (
          <FileViewer filePath={activeTab.data.filePath} />
        )}

        {/* Diff tab — horizontal diff viewer */}
        {activeTab?.type === "diff" && activeTab.data?.filePath && (
          <DiffTabContent
            workspaceId={workspace.id}
            filePath={activeTab.data.filePath}
            workspaceGitInfo={workspaceGitInfo}
          />
        )}
      </div>
    </div>
  );
});
