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
import type { ContentBlock } from "../types";
import type { ToolResultMap } from "../ui/chat-types";

interface SessionContextValue {
  parseContent: (content: string) => (ContentBlock | string)[] | string | null;
  toolResultMap: ToolResultMap;
}

const SessionContext = createContext<SessionContextValue | null>(null);

interface SessionProviderProps {
  parseContent: (content: string) => (ContentBlock | string)[] | string | null;
  toolResultMap: ToolResultMap;
  children: ReactNode;
}

export function SessionProvider({ parseContent, toolResultMap, children }: SessionProviderProps) {
  // Memoize context value to prevent unnecessary re-renders
  // React uses Object.is() to compare values, so new object {} !== {} even if contents are same
  const value = useMemo(() => ({ parseContent, toolResultMap }), [parseContent, toolResultMap]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) {
    throw new Error("useSession must be used within a SessionProvider");
  }
  return context;
}
