import { getAgentLabel } from "@/shared/agents";

interface BaseChatTab {
  id: string;
  title?: string | null;
  sequence?: number;
  agentHarness: string;
  hasStarted: boolean;
  initialModel?: string;
}

export interface SessionChatTab extends BaseChatTab {
  kind: "session";
  sessionId: string;
}

export interface PendingChatTab extends BaseChatTab {
  kind: "pending";
}

export type ChatTab = SessionChatTab | PendingChatTab;

export interface ClosedSessionTab extends BaseChatTab {
  sessionId: string;
  closedAt: number;
}

export function chatTabLabel({ title, sequence, agentHarness }: BaseChatTab): string {
  return title?.trim() || (sequence ? `${getAgentLabel(agentHarness)} #${sequence}` : "New chat");
}

export function isSessionChatTab(tab: ChatTab | null | undefined): tab is SessionChatTab {
  return !!tab && tab.kind === "session";
}

export function getChatTabSessionId(tab: ChatTab | null | undefined): string | null {
  return isSessionChatTab(tab) ? tab.sessionId : null;
}
