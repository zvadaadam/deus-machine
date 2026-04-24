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
import { getAgentLabel, getAgentHarnessForModel, type AgentHarness } from "@/shared/agents";
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

function buildStartedChatLabel(agentHarness: AgentHarness, sequence: number): string {
  return `${getAgentLabel(agentHarness)} #${sequence}`;
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

/** Build a tab from a session record. Sequence is computed externally. */
function sessionToTab(session: Session, sequence: number): SessionChatTab {
  const hasStarted = session.message_count > 0;
  return {
    kind: "session",
    id: `tab-${session.id}`,
    sessionId: session.id,
    label: hasStarted ? buildStartedChatLabel(session.agent_harness, sequence) : NEW_CHAT_LABEL,
    agentHarness: session.agent_harness,
    hasStarted,
  };
}

/** Count started tabs of a given agent type, excluding a specific tab. */
function countStartedTabsOfHarness(
  tabs: ChatTab[],
  agentHarness: AgentHarness,
  excludeTabId: string
): number {
  return tabs.filter(
    (tab) => tab.id !== excludeTabId && tab.hasStarted && tab.agentHarness === agentHarness
  ).length;
}

/** Compute per-harness sequence numbers for a list of sessions (in order). */
function computeSequences(sessions: Session[]): Map<string, number> {
  const counters = new Map<string, number>();
  const result = new Map<string, number>();
  for (const s of sessions) {
    if (s.message_count > 0) {
      const next = (counters.get(s.agent_harness) ?? 0) + 1;
      counters.set(s.agent_harness, next);
      result.set(s.id, next);
    }
  }
  return result;
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
        const seq = fallbackSession ? computeSequences([fallbackSession]) : new Map();
        const tab =
          fallbackSession && fallbackId
            ? sessionToTab(fallbackSession, seq.get(fallbackId) ?? 1)
            : fallbackId
              ? createPlaceholderSessionTab(fallbackId)
              : createPendingTab();
        setActiveMainTabId(tab.id);
        return [tab];
      }

      // Compute sequences across all valid sessions in tab order
      const orderedSessions = validTabs
        .filter(isSessionChatTab)
        .map((tab) => sessionMap.get(tab.sessionId)!)
        .filter(Boolean);
      const sequences = computeSequences(orderedSessions);

      // Hydrate each placeholder with real session data
      const hydratedTabs = validTabs.map((t) => {
        if (!isSessionChatTab(t)) return t;
        const session = sessionMap.get(t.sessionId)!;
        return sessionToTab(session, sequences.get(session.id) ?? 1);
      });

      // Fix active tab if it was orphaned
      setActiveMainTabId((prevActive) => {
        if (hydratedTabs.some((t) => t.id === prevActive)) return prevActive;
        return hydratedTabs[0]?.id ?? "tab-default";
      });

      return hydratedTabs;
    });
  }, [workspaceSessions, sessionMap, activeSessionId]);

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
      setMainTabs((prev) => {
        if (prev.length <= 1) return prev;

        const closingTab = prev.find((t) => t.id === tabId);
        const currentIndex = prev.findIndex((t) => t.id === tabId);
        const newTabs = prev.filter((t) => t.id !== tabId);

        if (closingTab && isSessionChatTab(closingTab)) {
          setClosedTabs((prevClosed) => {
            const entry: ClosedSessionTab = {
              label: closingTab.label,
              sessionId: closingTab.sessionId,
              agentHarness: closingTab.agentHarness,
              hasStarted: closingTab.hasStarted,
              initialModel: closingTab.initialModel,
              closedAt: Date.now(),
            };
            return [entry, ...prevClosed].slice(0, MAX_CLOSED_TABS);
          });
          sessionComposerActions.discard(closingTab.sessionId);
        }

        if (tabId === activeMainTabId && newTabs.length > 0) {
          const targetIndex = currentIndex > 0 ? currentIndex - 1 : 0;
          setActiveMainTabId(newTabs[targetIndex].id);
          setFocusActiveTabKey((prevKey) => prevKey + 1);
        }
        return newTabs;
      });
    },
    [activeMainTabId]
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

      const agentHarness = tab.agentHarness;
      const sequence = countStartedTabsOfHarness(prevTabs, agentHarness, tabId) + 1;

      const updatedTabs = [...prevTabs];
      updatedTabs[tabIndex] = {
        ...tab,
        label: buildStartedChatLabel(agentHarness, sequence),
        hasStarted: true,
      };
      return updatedTabs;
    });
  }, []);

  const handleTabReorder = useCallback((reorderedTabs: ChatTab[]) => {
    setMainTabs(reorderedTabs);
  }, []);

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
        if (closedTabs.length === 0) return;
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
    closedTabs.length,
    handleTabAdd,
    handleTabClose,
    handleTabRestore,
    mainTabs.length,
  ]);

  // --- Derived state ---

  const activeTab = mainTabs.find((t) => t.id === activeMainTabId);

  return {
    tabs: mainTabs,
    activeTabId: activeMainTabId,
    activeTab,
    closedTabs,
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
