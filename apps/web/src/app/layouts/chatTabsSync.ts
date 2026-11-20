/**
 * How a workspace's chat tabs follow its live chat list, as pure functions
 * (useChatTabs applies them): a chat that arrives (another chat or an agent
 * started it) becomes a tab unless the person closed it; one that leaves the
 * list (put away, deleted) leaves its tab and the closed list. Nothing
 * changed, the same arrays come back, so React sees no update.
 */

import { getAgentLabel, type AgentHarness } from "@/shared/agents";
import type { Session } from "@/features/session/types";
import type {
  ChatTab,
  ClosedSessionTab,
  PendingChatTab,
  SessionChatTab,
} from "@/features/session/ui/tabs";
import { isSessionChatTab } from "@/features/session/ui/tabs";

export const NEW_CHAT_LABEL = "New chat";

export function getOpenSessionIds(tabs: ChatTab[]): Set<string> {
  const ids = new Set<string>();
  for (const tab of tabs) {
    if (isSessionChatTab(tab)) ids.add(tab.sessionId);
  }
  return ids;
}

export function buildStartedChatLabel(agentHarness: AgentHarness, sequence: number): string {
  return `${getAgentLabel(agentHarness)} #${sequence}`;
}

export function createPendingTab(): PendingChatTab {
  return {
    kind: "pending",
    id: "tab-default",
    label: NEW_CHAT_LABEL,
    agentHarness: "claude-code",
    hasStarted: false,
  };
}

/** Build a tab from a session record. Sequence is computed externally. */
export function sessionToTab(session: Session, sequence: number): SessionChatTab {
  const hasStarted = session.message_count > 0;
  return {
    kind: "session",
    id: `tab-${session.id}`,
    sessionId: session.id,
    label: hasStarted ? buildStartedChatLabel(session.agent_harness, sequence) : NEW_CHAT_LABEL,
    agentHarness: session.agent_harness,
    hasStarted,
    // Hydrated tabs let SessionComposer restore the model from recorded turns.
    // initialModel is reserved for an explicit choice when opening a new tab.
  };
}

/** Keep existing labels stable when chats start out of order or tabs close. */
export function nextStartedChatLabel(tabs: ChatTab[], agentHarness: AgentHarness): string {
  const labels = new Set(tabs.filter((tab) => tab.hasStarted).map((tab) => tab.label));
  let sequence = 1;
  while (labels.has(buildStartedChatLabel(agentHarness, sequence))) sequence++;
  return buildStartedChatLabel(agentHarness, sequence);
}

/** A tab for a chat that arrived, labelled after the tabs already there. */
export function arrivedTab(tabs: ChatTab[], session: Session): SessionChatTab {
  return {
    ...sessionToTab(session, 1),
    ...(session.message_count > 0
      ? { label: nextStartedChatLabel(tabs, session.agent_harness) }
      : {}),
  };
}

export interface TabsAndClosed {
  tabs: ChatTab[];
  closed: ClosedSessionTab[];
}

/**
 * The tabs and the closed list after a live update of the chat list, given
 * the chats seen before it. Returns the same arrays when nothing changed.
 */
export function reconcileLive(
  current: TabsAndClosed,
  sessions: readonly Session[],
  seen: ReadonlySet<string>
): TabsAndClosed {
  const live = new Map(sessions.map((s) => [s.id, s]));
  const gone = new Set([...seen].filter((id) => !live.has(id)));
  const arrived = sessions.filter((s) => !seen.has(s.id));

  const closed = current.closed.some((c) => gone.has(c.sessionId))
    ? current.closed.filter((c) => !gone.has(c.sessionId))
    : current.closed;

  let tabs = current.tabs.filter((tab) => !isSessionChatTab(tab) || !gone.has(tab.sessionId));
  let changed = tabs.length !== current.tabs.length;
  const open = getOpenSessionIds(tabs);
  const closedIds = new Set(closed.map((c) => c.sessionId));
  for (const session of arrived) {
    if (open.has(session.id) || closedIds.has(session.id)) continue;
    changed = true;
    // The workspace's first chat arriving takes the place of the placeholder tab.
    const placeholder = tabs.findIndex((tab) => tab.kind === "pending");
    tabs =
      placeholder >= 0
        ? tabs.map((tab, i) => (i === placeholder ? arrivedTab(tabs, session) : tab))
        : [...tabs, arrivedTab(tabs, session)];
  }
  // A cloud snapshot can establish that an untitled chat has started after
  // discovery has already hydrated the tabs. Preserve order and draft choices.
  // Labels allocated one after another, against the list as it is built.
  tabs = [...tabs];
  tabs.forEach((tab, i) => {
    const session = isSessionChatTab(tab) ? live.get(tab.sessionId) : undefined;
    if (tab.hasStarted || !session || session.message_count === 0) return;
    changed = true;
    tabs[i] = {
      ...tab,
      hasStarted: true,
      initialModel: undefined,
      agentHarness: session.agent_harness,
      label: nextStartedChatLabel(tabs, session.agent_harness),
    };
  });
  if (!changed) tabs = current.tabs;
  else if (tabs.length === 0) tabs = [createPendingTab()];
  return { tabs, closed };
}

/**
 * Chats to open as tabs when the view mounts: those that arrived while it
 * was not on screen (not among the chats it knew when it last saved). With
 * no saved knowledge (a layout from before it was kept), none: a chat the
 * person closed must not come back.
 */
export function arrivedWhileAway(
  sessions: readonly Session[],
  openIds: ReadonlySet<string>,
  known: readonly string[]
): Session[] {
  if (known.length === 0) return [];
  const knew = new Set(known);
  return sessions.filter((s) => !openIds.has(s.id) && !knew.has(s.id));
}
