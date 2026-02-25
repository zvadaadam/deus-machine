// gateway/types.ts
// Core type definitions for the messaging gateway.

/** Supported messaging channels */
export type Channel = "telegram" | "whatsapp";

/** Inbound message from a messaging platform */
export interface InboundMessage {
  channel: Channel;
  chatId: string;
  userId: string;
  text: string;
  /** Original message ID from the platform */
  messageId: string;
}

/** Outbound message to send to a messaging platform */
export interface OutboundMessage {
  channel: Channel;
  chatId: string;
  text: string;
  /** Parse mode for rich text (Markdown, HTML) */
  parseMode?: "Markdown" | "HTML";
}

/** Binding between a chat and a workspace/session */
export interface ChannelBinding {
  channel: Channel;
  chatId: string;
  workspaceId: string;
  sessionId: string;
  workspacePath: string;
  repoName: string;
  workspaceName: string;
}

/** Parsed gateway command from a slash command */
export type GatewayCommand =
  | { type: "repos" }
  | { type: "workspace"; name?: string }
  | { type: "status" }
  | { type: "diff" }
  | { type: "stop" }
  | { type: "new"; repoId?: string }
  | { type: "help" }
  | { type: "unbind" };

/** Agent message notification from sidecar (matches sidecar/protocol.ts MessageResponse) */
export interface AgentMessageNotification {
  id: string;
  type: "message";
  agentType: string;
  data: unknown;
}

/** Agent error notification from sidecar */
export interface AgentErrorNotification {
  id: string;
  type: "error";
  error: string;
  agentType: string;
}
