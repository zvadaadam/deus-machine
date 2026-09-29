/**
 * Session Context
 *
 * Provides session-level data to all child components.
 * Eliminates props drilling through Chat → MessageItem → blocks.
 */

import { createContext, useContext, type ReactNode, useMemo, useCallback } from "react";
import type { Message, SessionStatus } from "../types";
import { openWorkspaceResource, type WorkspaceResource } from "../lib/openWorkspaceResource";

interface SessionContextValue {
  sessionStatus: SessionStatus;
  workspaceId: string | null;
  workspacePath: string | null;
  /** Subagent child messages grouped by parent tool_use_id */
  subagentMessages: Map<string, Message[]>;
  /** True when rendering inside a subagent — prevents recursive nesting */
  insideSubagent: boolean;
  openResource: (resource: WorkspaceResource) => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

interface SessionProviderProps {
  sessionStatus: SessionStatus;
  workspaceId?: string | null;
  workspacePath?: string | null;
  subagentMessages: Map<string, Message[]>;
  insideSubagent?: boolean;
  browserAvailable?: boolean;
  /** Embedded hosts choose where the resource becomes visible. */
  onOpenResource?: (resource: WorkspaceResource) => void;
  children: ReactNode;
}

export function SessionProvider({
  sessionStatus,
  workspaceId = null,
  workspacePath = null,
  subagentMessages,
  insideSubagent = false,
  browserAvailable,
  onOpenResource,
  children,
}: SessionProviderProps) {
  const openResource = useCallback(
    (resource: WorkspaceResource) => {
      if (onOpenResource) onOpenResource(resource);
      else if (workspaceId) openWorkspaceResource(workspaceId, resource, browserAvailable);
    },
    [onOpenResource, workspaceId, browserAvailable]
  );
  const value = useMemo(
    () => ({
      sessionStatus,
      workspaceId,
      workspacePath,
      subagentMessages,
      insideSubagent,
      openResource,
    }),
    [sessionStatus, workspaceId, workspacePath, subagentMessages, insideSubagent, openResource]
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
