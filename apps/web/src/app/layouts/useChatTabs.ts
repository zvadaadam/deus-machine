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
import type { Tab, ClosedTab } from "@/features/workspace/ui/MainContentTabs";
import type { Session } from "@/features/session/types";

const NEW_CHAT_LABEL = "New chat";
const MAX_CLOSED_TABS = 20;

function buildStartedChatLabel(agentHarness: string, sequence: number): string {
  return `${getAgentLabel(agentHarness)} #${sequence}`;
}

/** Build a Tab from a session record. Sequence is computed externally. */
function sessionToTab(session: Session, sequence: number): Tab {
  const hasStarted = session.message_count > 0;
  return {
    id: `tab-${session.id}`,
    label: hasStarted ? buildStartedChatLabel(session.agent_harness, sequence) : NEW_CHAT_LABEL,
    data: {
      sessionId: session.id,
      agentHarness: session.agent_harness,
      hasStarted,
    },
  };
}

/** Count started tabs of a given agent type, excluding a specific tab. */
function countStartedTabsOfHarness(
  tabs: Tab[],
  agentHarness: string,
  excludeTabId: string
): number {
  return tabs.filter(
    (t) => t.id !== excludeTabId && t.data?.hasStarted && t.data?.agentHarness === agentHarness
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

  const [mainTabs, setMainTabs] = useState<Tab[]>(() => {
    const layout = workspaceLayoutActions.getLayout(workspaceId);
    const persistedIds = layout.chatTabSessionIds;

    if (persistedIds.length === 0) {
      // First mount or migration — single tab with workspace's active session
      return [
        {
          id: activeSessionId ? `tab-${activeSessionId}` : "tab-default",
          label: NEW_CHAT_LABEL,
          data: {
            sessionId: activeSessionId ?? undefined,
            agentHarness: "claude",
            hasStarted: false,
          },
        },
      ];
    }

    // Create placeholder tabs from persisted IDs (synchronous, instant)
    return persistedIds.map((sessionId) => ({
      id: `tab-${sessionId}`,
      label: NEW_CHAT_LABEL,
      data: {
        sessionId,
        agentHarness: "claude",
        hasStarted: false,
      },
    }));
  });

  const [activeMainTabId, setActiveMainTabId] = useState<string>(() => {
    const layout = workspaceLayoutActions.getLayout(workspaceId);
    if (layout.activeChatTabSessionId) {
      return `tab-${layout.activeChatTabSessionId}`;
    }
    return activeSessionId ? `tab-${activeSessionId}` : "tab-default";
  });

  const [closedTabs, setClosedTabs] = useState<ClosedTab[]>([]);

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
        id: `tab-${activeSessionId}`,
        data: {
          ...updated[defaultIdx].data,
          sessionId: activeSessionId,
        },
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
      const validTabs = prev.filter((t) => {
        const sid = t.data?.sessionId;
        return sid && sessionMap.has(sid);
      });

      if (validTabs.length === 0) {
        // All persisted sessions are gone — fall back to active session
        const fallbackId = activeSessionId;
        const fallbackSession = fallbackId ? sessionMap.get(fallbackId) : undefined;
        const seq = fallbackSession ? computeSequences([fallbackSession]) : new Map();
        const tab = fallbackSession
          ? sessionToTab(fallbackSession, seq.get(fallbackId!) ?? 1)
          : {
              id: fallbackId ? `tab-${fallbackId}` : "tab-default",
              label: NEW_CHAT_LABEL,
              data: {
                sessionId: fallbackId ?? undefined,
                agentHarness: "claude",
                hasStarted: false,
              },
            };
        setActiveMainTabId(tab.id);
        return [tab];
      }

      // Compute sequences across all valid sessions in tab order
      const orderedSessions = validTabs
        .map((t) => sessionMap.get(t.data!.sessionId!)!)
        .filter(Boolean);
      const sequences = computeSequences(orderedSessions);

      // Hydrate each placeholder with real session data
      const hydratedTabs = validTabs.map((t) => {
        const session = sessionMap.get(t.data!.sessionId!)!;
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
      const chatSessionIds = mainTabs
        .filter((t) => t.data?.sessionId)
        .map((t) => t.data!.sessionId!);

      const activeTab = mainTabs.find((t) => t.id === activeMainTabId);
      const activeSessionIdForPersist = activeTab?.data?.sessionId ?? null;

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

        // Save closed tab for restore
        if (closingTab?.data?.sessionId) {
          setClosedTabs((prevClosed) => {
            const entry: ClosedTab = {
              label: closingTab.label,
              sessionId: closingTab.data!.sessionId!,
              agentHarness: closingTab.data?.agentHarness,
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

  const handleTabAdd = useCallback(
    async (initialModel?: string) => {
      try {
        const newSession = await createSessionMutation.mutateAsync(workspaceId);
        const agentHarness = initialModel ? getAgentHarnessForModel(initialModel) : "claude";
        const newId = `tab-${newSession.id}`;
        const newTab: Tab = {
          id: newId,
          label: NEW_CHAT_LABEL,
          data: {
            sessionId: newSession.id,
            agentHarness,
            hasStarted: false,
            initialModel,
          },
        };
        setMainTabs((prevTabs) => [...prevTabs, newTab]);
        setActiveMainTabId(newId);
      } catch (error) {
        console.error("[useChatTabs] Failed to create new session:", error);
        toast.error("Failed to create new chat session");
      }
    },
    [workspaceId, createSessionMutation]
  );

  const handleTabRestore = useCallback((closedTab: ClosedTab) => {
    const newId = `tab-${closedTab.sessionId}`;

    const restoredTab: Tab = {
      id: newId,
      label: closedTab.label,
      data: {
        sessionId: closedTab.sessionId,
        agentHarness: closedTab.agentHarness,
        hasStarted: closedTab.label !== NEW_CHAT_LABEL,
      },
    };

    setMainTabs((prev) => {
      // Don't add duplicate if session is already open in a tab
      if (prev.some((t) => t.data?.sessionId === closedTab.sessionId)) {
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
      if (tab.data?.agentHarness === nextAgentHarness) return prevTabs;

      const hasStarted = Boolean(tab.data?.hasStarted);

      let nextLabel = hasStarted ? tab.label : NEW_CHAT_LABEL;

      if (hasStarted) {
        const sequence = countStartedTabsOfHarness(prevTabs, nextAgentHarness, tabId) + 1;
        nextLabel = buildStartedChatLabel(nextAgentHarness, sequence);
      }

      const updatedTabs = [...prevTabs];
      updatedTabs[tabIndex] = {
        ...tab,
        label: nextLabel,
        data: { ...tab.data, agentHarness: nextAgentHarness, hasStarted },
      };
      return updatedTabs;
    });
  }, []);

  const markChatTabStarted = useCallback((tabId: string) => {
    setMainTabs((prevTabs) => {
      const tabIndex = prevTabs.findIndex((tab) => tab.id === tabId);
      if (tabIndex === -1) return prevTabs;

      const tab = prevTabs[tabIndex];
      if (tab.data?.hasStarted) return prevTabs;

      const agentHarness = (tab.data?.agentHarness as AgentHarness | undefined) ?? "claude";
      const sequence = countStartedTabsOfHarness(prevTabs, agentHarness, tabId) + 1;

      const updatedTabs = [...prevTabs];
      updatedTabs[tabIndex] = {
        ...tab,
        label: buildStartedChatLabel(agentHarness, sequence),
        data: { ...tab.data, agentHarness, hasStarted: true },
      };
      return updatedTabs;
    });
  }, []);

  const handleTabReorder = useCallback((reorderedTabs: Tab[]) => {
    setMainTabs(reorderedTabs);
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
    updateChatTabAgentHarness,
    markChatTabStarted,
  };
}
