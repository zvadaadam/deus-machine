import type { AgentHarness } from "@/shared/agents";

interface BaseChatTab {
  id: string;
  label: string;
  agentHarness: AgentHarness;
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

export interface ClosedSessionTab {
  label: string;
  sessionId: string;
  agentHarness: AgentHarness;
  hasStarted: boolean;
  initialModel?: string;
  closedAt: number;
}

export function isSessionChatTab(tab: ChatTab | null | undefined): tab is SessionChatTab {
  return !!tab && tab.kind === "session";
}

export function getChatTabSessionId(tab: ChatTab | null | undefined): string | null {
  return isSessionChatTab(tab) ? tab.sessionId : null;
}
