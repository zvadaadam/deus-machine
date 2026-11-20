/**
 * useChatTabs — manages chat tab lifecycle with persistence across workspace switches.
 *
 * Tab order and active tab are persisted in workspaceLayoutStore (localStorage).
 * Full tab metadata (agentHarness, hasStarted, label) is reconstructed from session
 * records fetched via useWorkspaceSessions.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { toast } from "sonner";
import { isCloudDirectWebMode } from "@/shared/config/webDirectMode";
import { useCreateSession, useWorkspaceSessions } from "@/features/session/api/session.queries";
import { getAgentHarnessForModel, type AgentHarness } from "@/shared/agents";
import { workspaceLayoutActions } from "@/features/workspace/store/workspaceLayoutStore";
import {
  sessionComposerActions,
  useSessionComposerStore,
} from "@/features/session/store/sessionComposerStore";
import type { Session } from "@/features/session/types";
import type { ChatTab, ClosedSessionTab, SessionChatTab } from "@/features/session/ui/tabs";
import { getChatTabSessionId, isSessionChatTab } from "@/features/session/ui/tabs";
import {
  NEW_CHAT_LABEL,
  arrivedTab,
  arrivedWhileAway,
  createPendingTab,
  getOpenSessionIds,
  nextStartedChatLabel,
  reconcileLive,
  sessionToTab,
} from "./chatTabsSync";
import { openChatDone, useOpenChatStore } from "@/features/session/lib/openChat";

const MAX_CLOSED_TABS = 20;

function createClosedTabId(sessionId: string): string {
  return `${sessionId}-${Date.now()}-${crypto.randomUUID()}`;
}

function createPlaceholderSessionTab(
  sessionId: string,
  agentHarness: AgentHarness = "claude-code",
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
  /** Chats the live list has shown: one gone from it since was put away (or deleted). */
  const seen = useRef(new Set<string>());
  // The latest tabs and closed list, for a live update to reconcile against without
  // depending on them (an effect that sets what it depends on loops).
  const latest = useRef<{ tabs: ChatTab[]; closed: ClosedSessionTab[] }>({
    tabs: mainTabs,
    closed: closedTabs,
  });
  useEffect(() => {
    latest.current = { tabs: mainTabs, closed: closedTabs };
  });
  useEffect(() => {
    if (!workspaceSessions) return;
    if (hydrated.current) {
      const next = reconcileLive(latest.current, workspaceSessions, seen.current);
      seen.current = new Set(workspaceSessions.map((s) => s.id));
      if (next.closed !== latest.current.closed) setClosedTabs(next.closed);
      if (next.tabs !== latest.current.tabs) {
        setMainTabs(next.tabs);
        setActiveMainTabId((active) =>
          next.tabs.some((t) => t.id === active) ? active : (next.tabs.at(-1)?.id ?? "tab-default")
        );
      }
      return;
    }
    hydrated.current = true;
    seen.current = new Set(workspaceSessions.map((s) => s.id));
    const known = workspaceLayoutActions.getLayout(workspaceId).knownChatSessionIds;

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

      // Chats that arrived while the workspace was not on screen become tabs too.
      for (const session of arrivedWhileAway(
        workspaceSessions,
        getOpenSessionIds(hydratedTabs),
        known
      ))
        hydratedTabs.push(arrivedTab(hydratedTabs, session));

      // Fix active tab if it was orphaned
      setActiveMainTabId((prevActive) => {
        if (hydratedTabs.some((t) => t.id === prevActive)) return prevActive;
        return hydratedTabs[0]?.id ?? "tab-default";
      });

      return hydratedTabs;
    });
  }, [workspaceSessions, sessionMap, activeSessionId, workspaceId]);

  // --- A request to show one chat (openChat), taken when mounted or already mounted ---

  const requested = useOpenChatStore((state) => state.requested[workspaceId]);
  useEffect(() => {
    // Taken once the authoritative list is here: a target in it is shown, one not in it dropped.
    if (!requested || !hydrated.current || !workspaceSessions) return;
    openChatDone(workspaceId, requested.id);
    const session = sessionMap.get(requested.sessionId);
    if (!session) return;
    const target = requested.sessionId;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- consume a navigation request
    setMainTabs((tabs) =>
      tabs.some((t) => isSessionChatTab(t) && t.sessionId === target)
        ? tabs
        : [...tabs, arrivedTab(tabs, session)]
    );
    setClosedTabs((closed) => closed.filter((c) => c.sessionId !== target));
    setActiveMainTabId(`tab-${target}`);
  }, [requested, sessionMap, workspaceSessions, workspaceId]);

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
        activeSessionIdForPersist,
        // What this view knew, so chats that arrive while it is away open as tabs next time.
        hydrated.current ? [...seen.current] : undefined
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
          // Preserve the current pick even when the send ACK precedes turn history.
          initialModel:
            useSessionComposerStore.getState().composers[closingTab.sessionId]?.model ??
            closingTab.initialModel,
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
      // Web-direct has no session-create path yet (the mutate lane needs the
      // Mac backend; agnt-side creation is a follow-up) — every entry point
      // funnels through here (+ button, Cmd+T, open-in-new-tab), so one guard
      // keeps them all honest instead of rejecting after the fact.
      if (isCloudDirectWebMode()) {
        toast.error("New chats are started from the desktop app for now");
        return;
      }
      try {
        const newSession = await createSessionMutation.mutateAsync(workspaceId);
        const agentHarness = initialModel ? getAgentHarnessForModel(initialModel) : "claude-code";
        const newTab = createPlaceholderSessionTab(newSession.id, agentHarness, initialModel);
        // The live list may have added it already: one tab, with the person's choice.
        setMainTabs((prevTabs) =>
          prevTabs.some((t) => t.id === newTab.id)
            ? prevTabs.map((t) =>
                t.id === newTab.id && !t.hasStarted ? { ...t, agentHarness, initialModel } : t
              )
            : [...prevTabs, newTab]
        );
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
      return [
        ...prev,
        restoredTab.hasStarted && prev.some((tab) => tab.label === restoredTab.label)
          ? { ...restoredTab, label: nextStartedChatLabel(prev, restoredTab.agentHarness) }
          : restoredTab,
      ];
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
        label: nextStartedChatLabel(prevTabs, tab.agentHarness),
        hasStarted: true,
        initialModel: undefined,
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
