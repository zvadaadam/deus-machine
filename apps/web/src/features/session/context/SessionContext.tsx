/**
 * Session Context
 *
 * Provides session-level data (parseContent, toolResultMap) to all child components.
 * Eliminates props drilling through Chat → MessageItem → BlockRenderer.
 *
 * Usage:
 *   <SessionProvider parseContent={parseContent} toolResultMap={toolResultMap}>
 *     <Chat messages={messages} ... />
 *   </SessionProvider>
 *
 *   // In child components:
 *   const { parseContent, toolResultMap } = useSession();
 */

import { createContext, useContext, ReactNode, useMemo } from "react";
import type { ContentBlock, Message, MessageRole, SessionStatus } from "../types";
import type { ToolResultMap } from "../ui/chat-types";
import type { MessagePartsEnvelope } from "@shared/messages";

interface SessionContextValue {
  parseContent: (content: string) => (ContentBlock | string)[] | string;
  toolResultMap: ToolResultMap;
  parentToolUseMap: Map<string, string>; // messageId → parentToolUseId
  subagentMessages: Map<string, Message[]>; // toolUseId → child messages
  partsMap: Map<string, MessagePartsEnvelope>; // messageId → parsed Parts envelope
  sessionStatus: SessionStatus;
  /** Renders a content block via BlockRenderer. Injected to break circular imports. */
  renderBlock: (
    block: ContentBlock | string,
    index: number,
    role?: MessageRole,
    isStreaming?: boolean
  ) => ReactNode;
}

const SessionContext = createContext<SessionContextValue | null>(null);

interface SessionProviderProps {
  parseContent: (content: string) => (ContentBlock | string)[] | string;
  toolResultMap: ToolResultMap;
  parentToolUseMap: Map<string, string>;
  subagentMessages: Map<string, Message[]>;
  partsMap: Map<string, MessagePartsEnvelope>;
  sessionStatus: SessionStatus;
  /** Renders a content block via BlockRenderer. Injected to break circular imports. */
  renderBlock: (
    block: ContentBlock | string,
    index: number,
    role?: MessageRole,
    isStreaming?: boolean
  ) => ReactNode;
  children: ReactNode;
}

export function SessionProvider({
  parseContent,
  toolResultMap,
  parentToolUseMap,
  subagentMessages,
  partsMap,
  sessionStatus,
  renderBlock,
  children,
}: SessionProviderProps) {
  // Memoize context value to prevent unnecessary re-renders
  // React uses Object.is() to compare values, so new object {} !== {} even if contents are same
  const value = useMemo(
    () => ({
      parseContent,
      toolResultMap,
      parentToolUseMap,
      subagentMessages,
      partsMap,
      sessionStatus,
      renderBlock,
    }),
    [
      parseContent,
      toolResultMap,
      parentToolUseMap,
      subagentMessages,
      partsMap,
      sessionStatus,
      renderBlock,
    ]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) {
    throw new Error("useSession must be used within a SessionProvider");
  }
  return context;
}
