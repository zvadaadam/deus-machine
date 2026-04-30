/**
 * useChatTabs — manages chat tab lifecycle with persistence across workspace switches.
 *
 * Tab order and active tab are persisted in workspaceLayoutStore (localStorage).
 * Full tab metadata (agentHarness, hasStarted, label) is reconstructed from session
 * records fetched via useWorkspaceSessions.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { toast } from "sonner";
import { useCreateSession, useWorkspaceSessions } from "@/features/session/api/session.queries";
import { getAgentHarnessForModel, type AgentHarness } from "@/shared/agents";
import { workspaceLayoutActions } from "@/features/workspace/store/workspaceLayoutStore";
import { sessionComposerActions } from "@/features/session/store/sessionComposerStore";
import type { Session } from "@/features/session/types";
import type {
  ChatTab,
  ClosedSessionTab,
  PendingChatTab,
  SessionChatTab,
} from "@/features/session/ui/tabs";
import { getChatTabSessionId, isSessionChatTab } from "@/features/session/ui/tabs";

const NEW_CHAT_LABEL = "New chat";
const MAX_CLOSED_TABS = 20;

function createClosedTabId(sessionId: string): string {
  return `${sessionId}-${Date.now()}-${crypto.randomUUID()}`;
}

function getOpenSessionIds(tabs: ChatTab[]): Set<string> {
  const ids = new Set<string>();
  for (const tab of tabs) {
    if (isSessionChatTab(tab)) ids.add(tab.sessionId);
  }
  return ids;
}

function createPendingTab(): PendingChatTab {
  return {
    kind: "pending",
    id: "tab-default",
    label: NEW_CHAT_LABEL,
    agentHarness: "claude",
    hasStarted: false,
  };
}

function createPlaceholderSessionTab(
  sessionId: string,
  agentHarness: AgentHarness = "claude",
  initialModel?: string
): SessionChatTab {
  return {
    kind: "session",
    id: `tab-${sessionId}`,
    sessionId,
    label: NEW_CHAT_LABEL,
    agentHarness,
    hasStarted: false,
    initialModel,
  };
}

function getSessionTabLabel(session: Session): string {
  const title = session.title?.trim();
  if (title && title.toLowerCase() !== "(session)") return title;
  return NEW_CHAT_LABEL;
}

/** Build a tab from a session record. */
function sessionToTab(session: Session): SessionChatTab {
  const hasStarted = session.message_count > 0;
  return {
    kind: "session",
    id: `tab-${session.id}`,
    sessionId: session.id,
    label: getSessionTabLabel(session),
    agentHarness: session.agent_harness,
    hasStarted,
  };
}

interface UseChatTabsOptions {
  workspaceId: string;
  activeSessionId: string | null | undefined;
}

export function useChatTabs({ workspaceId, activeSessionId }: UseChatTabsOptions) {
  // Fetch all sessions for this workspace (for hydrating tab metadata)
  const { data: workspaceSessions } = useWorkspaceSessions(workspaceId);

  // Build session lookup map
  const sessionMap = useMemo(() => {
    const map = new Map<string, Session>();
    if (workspaceSessions) {
      for (const s of workspaceSessions) map.set(s.id, s);
    }
    return map;
  }, [workspaceSessions]);

  // --- Hydrate initial state from localStorage + session data ---

  const [mainTabs, setMainTabs] = useState<ChatTab[]>(() => {
    const layout = workspaceLayoutActions.getLayout(workspaceId);
    const persistedIds = layout.chatTabSessionIds;

    if (persistedIds.length === 0) {
      return [activeSessionId ? createPlaceholderSessionTab(activeSessionId) : createPendingTab()];
    }

    return persistedIds.map((sessionId) => createPlaceholderSessionTab(sessionId));
  });

  const [activeMainTabId, setActiveMainTabId] = useState<string>(() => {
    const layout = workspaceLayoutActions.getLayout(workspaceId);
    if (layout.activeChatTabSessionId) {
      return `tab-${layout.activeChatTabSessionId}`;
    }
    return activeSessionId ? `tab-${activeSessionId}` : "tab-default";
  });

  const [closedTabs, setClosedTabs] = useState<ClosedSessionTab[]>([]);
  const [focusActiveTabKey, setFocusActiveTabKey] = useState(0);

  const createSessionMutation = useCreateSession();

  // --- Patch default tab when workspace init completes ---
  // When a workspace transitions from initializing → ready, activeSessionId
  // goes from null to a UUID. Update the placeholder "tab-default" in-place
  // so ChatArea can render SessionPanel without a full remount.
  const prevActiveSessionIdRef = useRef(activeSessionId);
  useEffect(() => {
    const prev = prevActiveSessionIdRef.current;
    prevActiveSessionIdRef.current = activeSessionId;

    // Only act when transitioning from null/undefined → real session ID
    if (prev || !activeSessionId) return;

    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time patch when workspace init completes
    setMainTabs((tabs) => {
      const defaultIdx = tabs.findIndex((t) => t.id === "tab-default");
      if (defaultIdx === -1) return tabs;

      const updated = [...tabs];
      updated[defaultIdx] = {
        ...updated[defaultIdx],
        kind: "session",
        id: `tab-${activeSessionId}`,
        sessionId: activeSessionId,
      };
      return updated;
    });

    setActiveMainTabId((prev) => (prev === "tab-default" ? `tab-${activeSessionId}` : prev));
  }, [activeSessionId]);

  // --- Hydrate tabs with real session data when sessions load ---

  const hydrated = useRef(false);
  useEffect(() => {
    if (!workspaceSessions || hydrated.current) return;
    hydrated.current = true;

    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time hydration sync from DB
    setMainTabs((prev) => {
      // Filter out orphaned session IDs (deleted from DB)
      const validTabs = prev.filter(
        (tab) => !isSessionChatTab(tab) || sessionMap.has(tab.sessionId)
      );

      if (validTabs.length === 0) {
        // All persisted sessions are gone — fall back to active session
        const fallbackId = activeSessionId;
        const fallbackSession = fallbackId ? sessionMap.get(fallbackId) : undefined;
        const tab =
          fallbackSession && fallbackId
            ? sessionToTab(fallbackSession)
            : fallbackId
              ? createPlaceholderSessionTab(fallbackId)
              : createPendingTab();
        setActiveMainTabId(tab.id);
        return [tab];
      }

      // Hydrate each placeholder with real session data
      const hydratedTabs = validTabs.map((t) => {
        if (!isSessionChatTab(t)) return t;
        const session = sessionMap.get(t.sessionId)!;
        return sessionToTab(session);
      });

      // Fix active tab if it was orphaned
      setActiveMainTabId((prevActive) => {
        if (hydratedTabs.some((t) => t.id === prevActive)) return prevActive;
        return hydratedTabs[0]?.id ?? "tab-default";
      });

      return hydratedTabs;
    });
  }, [workspaceSessions, sessionMap, activeSessionId]);

  // Keep tab labels fresh as session metadata changes after first send.
  // The backend derives sessions.title from the first user message; this
  // sync turns "New chat" into the real title as soon as the WS snapshot lands.
  useEffect(() => {
    if (!workspaceSessions) return;

    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync tab metadata from WS-backed session snapshots
    setMainTabs((prevTabs) => {
      let changed = false;
      const nextTabs = prevTabs.map((tab) => {
        if (!isSessionChatTab(tab)) return tab;
        const session = sessionMap.get(tab.sessionId);
        if (!session) return tab;

        const nextTab = sessionToTab(session);
        if (
          tab.label === nextTab.label &&
          tab.agentHarness === nextTab.agentHarness &&
          tab.hasStarted === nextTab.hasStarted
        ) {
          return tab;
        }

        changed = true;
        return { ...tab, ...nextTab, initialModel: tab.initialModel };
      });

      return changed ? nextTabs : prevTabs;
    });
  }, [workspaceSessions, sessionMap]);

  // --- Persist tab state to localStorage on every change ---
  // Debounced to avoid writing on every intermediate state update.

  const persistTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    clearTimeout(persistTimeoutRef.current);
    persistTimeoutRef.current = setTimeout(() => {
      const chatSessionIds = mainTabs.filter(isSessionChatTab).map((tab) => tab.sessionId);

      const activeTab = mainTabs.find((t) => t.id === activeMainTabId);
      const activeSessionIdForPersist = getChatTabSessionId(activeTab);

      workspaceLayoutActions.setChatTabState(
        workspaceId,
        chatSessionIds,
        activeSessionIdForPersist
      );
    }, 100);

    return () => clearTimeout(persistTimeoutRef.current);
  }, [mainTabs, activeMainTabId, workspaceId]);

  // --- Tab handlers ---

  const handleTabChange = useCallback((tabId: string) => setActiveMainTabId(tabId), []);

  const handleTabClose = useCallback(
    (tabId: string) => {
      if (mainTabs.length <= 1) return;

      const closingTab = mainTabs.find((tab) => tab.id === tabId);
      const currentIndex = mainTabs.findIndex((tab) => tab.id === tabId);
      if (!closingTab || currentIndex === -1) return;

      const newTabs = mainTabs.filter((tab) => tab.id !== tabId);
      const openSessionIds = getOpenSessionIds(newTabs);

      setMainTabs(newTabs);

      if (isSessionChatTab(closingTab)) {
        const entry: ClosedSessionTab = {
          id: createClosedTabId(closingTab.sessionId),
          label: closingTab.label,
          sessionId: closingTab.sessionId,
          agentHarness: closingTab.agentHarness,
          hasStarted: closingTab.hasStarted,
          initialModel: closingTab.initialModel,
          closedAt: Date.now(),
        };
        setClosedTabs((prevClosed) =>
          [
            entry,
            ...prevClosed.filter(
              (closedTab) =>
                closedTab.sessionId !== closingTab.sessionId &&
                !openSessionIds.has(closedTab.sessionId)
            ),
          ].slice(0, MAX_CLOSED_TABS)
        );
        sessionComposerActions.discard(closingTab.sessionId);
      }

      if (tabId === activeMainTabId && newTabs.length > 0) {
        const targetIndex = currentIndex > 0 ? currentIndex - 1 : 0;
        setActiveMainTabId(newTabs[targetIndex].id);
        setFocusActiveTabKey((prevKey) => prevKey + 1);
      }
    },
    [activeMainTabId, mainTabs]
  );

  const handleTabAdd = useCallback(
    async (initialModel?: string) => {
      try {
        const newSession = await createSessionMutation.mutateAsync(workspaceId);
        const agentHarness = initialModel ? getAgentHarnessForModel(initialModel) : "claude";
        const newTab = createPlaceholderSessionTab(newSession.id, agentHarness, initialModel);
        setMainTabs((prevTabs) => [...prevTabs, newTab]);
        setActiveMainTabId(newTab.id);
      } catch (error) {
        console.error("[useChatTabs] Failed to create new session:", error);
        toast.error("Failed to create new chat session");
      }
    },
    [workspaceId, createSessionMutation]
  );

  const handleTabRestore = useCallback((closedTab: ClosedSessionTab) => {
    const newId = `tab-${closedTab.sessionId}`;

    const restoredTab: SessionChatTab = {
      kind: "session",
      id: newId,
      sessionId: closedTab.sessionId,
      label: closedTab.label,
      agentHarness: closedTab.agentHarness,
      hasStarted: closedTab.hasStarted,
      initialModel: closedTab.initialModel,
    };

    setMainTabs((prev) => {
      // Don't add duplicate if session is already open in a tab
      if (prev.some((tab) => isSessionChatTab(tab) && tab.sessionId === closedTab.sessionId)) {
        return prev;
      }
      return [...prev, restoredTab];
    });
    setActiveMainTabId(newId);
    setClosedTabs((prev) => prev.filter((ct) => ct.sessionId !== closedTab.sessionId));
  }, []);

  const updateChatTabAgentHarness = useCallback((tabId: string, nextAgentHarness: AgentHarness) => {
    setMainTabs((prevTabs) => {
      const tabIndex = prevTabs.findIndex((tab) => tab.id === tabId);
      if (tabIndex === -1) return prevTabs;

      const tab = prevTabs[tabIndex];
      if (tab.agentHarness === nextAgentHarness) return prevTabs;

      // Harness lock: once a session has messages, its harness is bound to a
      // specific SDK process (enforced server-side in handleSendMessage).
      // Ignore local harness changes on started tabs — otherwise the UI drifts
      // from the persisted session and the next send will be rejected anyway.
      if (tab.hasStarted) return prevTabs;

      const updatedTabs = [...prevTabs];
      updatedTabs[tabIndex] = {
        ...tab,
        label: NEW_CHAT_LABEL,
        agentHarness: nextAgentHarness,
        hasStarted: false,
      };
      return updatedTabs;
    });
  }, []);

  const markChatTabStarted = useCallback((tabId: string) => {
    setMainTabs((prevTabs) => {
      const tabIndex = prevTabs.findIndex((tab) => tab.id === tabId);
      if (tabIndex === -1) return prevTabs;

      const tab = prevTabs[tabIndex];
      if (tab.hasStarted) return prevTabs;

      const updatedTabs = [...prevTabs];
      updatedTabs[tabIndex] = {
        ...tab,
        hasStarted: true,
      };
      return updatedTabs;
    });
  }, []);

  const handleTabReorder = useCallback((reorderedTabs: ChatTab[]) => {
    setMainTabs(reorderedTabs);
  }, []);

  // --- Derived state ---

  const activeTab = mainTabs.find((t) => t.id === activeMainTabId);
  const openSessionIds = useMemo(() => getOpenSessionIds(mainTabs), [mainTabs]);
  const restorableClosedTabs = useMemo(
    () => closedTabs.filter((closedTab) => !openSessionIds.has(closedTab.sessionId)),
    [closedTabs, openSessionIds]
  );

  // --- Keyboard shortcuts ---

  function isTextFieldFocused(): boolean {
    const activeElement = document.activeElement as HTMLElement | null;
    return (
      !!activeElement &&
      (activeElement.tagName === "INPUT" ||
        activeElement.tagName === "TEXTAREA" ||
        activeElement.isContentEditable ||
        activeElement.getAttribute("role") === "textbox")
    );
  }

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const isModKey = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();

      // Cmd+Shift+T — restore last closed tab (check before Cmd+T)
      if (isModKey && e.shiftKey && key === "t") {
        const latestClosedTab = restorableClosedTabs[0];
        if (!latestClosedTab) return;
        e.preventDefault();
        handleTabRestore(latestClosedTab);
        return;
      }

      // Cmd+T — new chat tab
      if (isModKey && key === "t") {
        if (isTextFieldFocused()) return;

        e.preventDefault();
        handleTabAdd();
        return;
      }

      // Cmd+W — close active chat tab when multiple tabs are open
      if (isModKey && !e.shiftKey && key === "w") {
        if (mainTabs.length <= 1 || !activeMainTabId) return;
        if (isTextFieldFocused()) return;
        e.preventDefault();
        handleTabClose(activeMainTabId);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    activeMainTabId,
    handleTabAdd,
    handleTabClose,
    handleTabRestore,
    mainTabs.length,
    restorableClosedTabs,
  ]);

  return {
    tabs: mainTabs,
    activeTabId: activeMainTabId,
    activeTab,
    closedTabs: restorableClosedTabs,
    focusActiveTabKey,
    handleTabChange,
    handleTabClose,
    handleTabAdd,
    handleTabReorder,
    handleTabRestore,
    updateChatTabAgentHarness,
    markChatTabStarted,
  };
}
