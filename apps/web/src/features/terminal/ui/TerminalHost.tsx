/**
 * TerminalHost — persistent multi-workspace host for terminal workspace tabs.
 *
 * Unlike the old TerminalPanel, TerminalHost has NO nested tab bar: each
 * terminal tab lives directly in the unified right-pane WorkspaceTabBar.
 *
 * Keeps up to MAX_CACHED_WORKSPACES visited workspaces mounted (CSS-hidden
 * when inactive) so PTY processes and xterm scrollback survive tab switches
 * and workspace switches.
 */

import { useEffect, useState } from "react";
import { useWorkspaceLayoutStore } from "@/features/workspace/store";
import type { WorkspaceTab } from "@/features/workspace-tabs/types";
import { consumeTerminalInitialCommand } from "../store/terminalTaskStore";
import { Terminal } from "./Terminal";

const EMPTY_TABS: WorkspaceTab[] = [];
const MAX_CACHED_WORKSPACES = 5;

interface TerminalHostProps {
  workspaceId: string;
  workspacePath: string;
  /** Cloud workspaces: shells spawn in the sandbox over the session channel. */
  cloud?: boolean;
  /** ID of the currently active workspace tab (when it is a terminal tab). */
  activeTabId: string | null;
  /** Whether the terminal host itself is currently visible on screen. */
  panelVisible: boolean;
}

function WorkspaceTerminals({
  workspaceId,
  workspacePath,
  cloud,
  isCurrent,
  activeTabId,
  panelVisible,
}: {
  workspaceId: string;
  workspacePath: string;
  cloud?: boolean;
  isCurrent: boolean;
  activeTabId: string | null;
  panelVisible: boolean;
}) {
  const tabs = useWorkspaceLayoutStore((s) => s.layouts[workspaceId]?.workspaceTabs ?? EMPTY_TABS);

  return (
    <>
      {tabs.map((tab) => {
        if (tab.kind !== "terminal") return null;
        const isActive = isCurrent && activeTabId === tab.id;
        return (
          <div
            key={tab.id}
            className={
              isActive
                ? "h-full w-full"
                : "pointer-events-none invisible absolute inset-0 h-full w-full"
            }
          >
            <Terminal
              id={tab.id}
              workspacePath={workspacePath}
              cloudWorkspaceId={cloud ? workspaceId : undefined}
              consumeInitialCommand={consumeTerminalInitialCommand}
              visible={panelVisible && isActive}
            />
          </div>
        );
      })}
    </>
  );
}

export function TerminalHost({
  workspaceId,
  workspacePath,
  cloud,
  activeTabId,
  panelVisible,
}: TerminalHostProps) {
  const [visitedWorkspaces, setVisitedWorkspaces] = useState<Map<string, string>>(
    () => new Map([[workspaceId, workspacePath]])
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setVisitedWorkspaces((prev) => {
      const next = new Map(prev);
      if (next.has(workspaceId)) {
        if (next.get(workspaceId) === workspacePath) {
          next.delete(workspaceId);
          next.set(workspaceId, workspacePath);
          return next;
        }
        next.delete(workspaceId);
      }
      next.set(workspaceId, workspacePath);

      if (next.size > MAX_CACHED_WORKSPACES) {
        for (const wsId of next.keys()) {
          if (wsId !== workspaceId) {
            next.delete(wsId);
            break;
          }
        }
      }
      return next;
    });
  }, [workspaceId, workspacePath]);

  return (
    <div className="bg-background relative h-full w-full overflow-hidden">
      {Array.from(visitedWorkspaces.entries()).map(([wsId, wsPath]) => (
        <WorkspaceTerminals
          key={wsId}
          workspaceId={wsId}
          workspacePath={wsPath}
          cloud={cloud}
          isCurrent={wsId === workspaceId}
          activeTabId={activeTabId}
          panelVisible={panelVisible}
        />
      ))}
    </div>
  );
}
