/**
 * useChatTabs — manages chat tab lifecycle: create, close, restore, label updates.
 *
 * Owns all tab state (open tabs, active tab, closed history) and keyboard shortcuts.
 * ChatArea consumes this hook and focuses purely on rendering.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { toast } from "sonner";
import { useCreateSession } from "@/features/session/api/session.queries";
import { getRuntimeAgentLabel, type RuntimeAgentType } from "@/features/session/lib/agentRuntime";
import type { Tab, ClosedTab } from "@/features/workspace/ui/MainContentTabs";

const NEW_CHAT_LABEL = "New chat";
const MAX_CLOSED_TABS = 20;

function buildStartedChatLabel(agentType: string, sequence: number): string {
  return `${getRuntimeAgentLabel(agentType)} #${sequence}`;
}

interface UseChatTabsOptions {
  workspaceId: string;
  activeSessionId: string | null | undefined;
}

export function useChatTabs({ workspaceId, activeSessionId }: UseChatTabsOptions) {
  const [mainTabs, setMainTabs] = useState<Tab[]>([
    {
      id: "chat-1",
      label: NEW_CHAT_LABEL,
      type: "chat",
      data: {
        sessionId: activeSessionId ?? undefined,
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

  const handleTabChange = useCallback((tabId: string) => setActiveMainTabId(tabId), []);

  const handleTabClose = useCallback(
    (tabId: string) => {
      setMainTabs((prev) => {
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

  const handleTabAdd = useCallback(async () => {
    const idx = nextChatIndexRef.current++;
    const newId = `chat-${idx}`;

    try {
      const newSession = await createSessionMutation.mutateAsync(workspaceId);
      const newTab: Tab = {
        id: newId,
        label: NEW_CHAT_LABEL,
        type: "chat",
        data: { sessionId: newSession.id, agentType: "claude", hasStarted: false },
      };
      setMainTabs((prevTabs) => [...prevTabs, newTab]);
      setActiveMainTabId(newId);
    } catch (error) {
      console.error("[useChatTabs] Failed to create new session:", error);
      toast.error("Failed to create new chat session");
      nextChatIndexRef.current--;
    }
  }, [workspaceId, createSessionMutation]);

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
        hasStarted: closedTab.label !== NEW_CHAT_LABEL,
      },
    };

    setMainTabs((prev) => [...prev, restoredTab]);
    setActiveMainTabId(newId);
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
        data: { ...tab.data, agentType: nextAgentType, hasStarted, agentSequence: nextSequence },
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
        data: { ...tab.data, agentType, hasStarted: true, agentSequence: nextSequence },
      };
      return updatedTabs;
    });
  }, []);

  const handleTabReorder = useCallback((reorderedTabs: Tab[]) => {
    setMainTabs(reorderedTabs);
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
        handleTabAdd();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleTabAdd, handleTabRestore]);

  // --- Derived state ---

  const activeTab = mainTabs.find((t) => t.id === activeMainTabId);

  return {
    tabs: mainTabs,
    activeTabId: activeMainTabId,
    activeTab,
    closedTabs,
    handleTabChange,
    handleTabClose,
    handleTabAdd,
    handleTabReorder,
    handleTabRestore,
    updateChatTabAgentType,
    markChatTabStarted,
    openFileTab,
  };
}
