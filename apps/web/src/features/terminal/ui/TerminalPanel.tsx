import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Plus, Terminal as TerminalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TabPill } from "@/components/ui/tab-pill";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useTerminalTaskStore, consumeTerminalTask } from "../store/terminalTaskStore";
import { useWorkspaceLayoutStore, workspaceLayoutActions } from "@/features/workspace/store";
import type { PersistedTerminalTab } from "@/features/workspace/store/workspaceLayoutStore";
import { Terminal } from "./Terminal";

// Stable reference for empty terminal tabs — avoids Zustand getSnapshot infinite loop
// when the selector fallback `?? []` creates a new array on every render.
const EMPTY_TABS: PersistedTerminalTab[] = [];

// Cap the number of workspaces whose terminals stay alive simultaneously.
// Beyond this, the oldest non-current workspace is evicted — its Terminal
// components unmount, killing PTYs, disposing xterm, and tearing down
// IPC event listeners. Prevents O(N) pty-data fan-out at scale.
const MAX_CACHED_WORKSPACES = 5;

interface TerminalPanelProps {
  workspaceId: string;
  workspacePath: string;
  /** Whether the terminal panel is the active (visible) right-side tab */
  panelVisible?: boolean;
  onCollapse?: () => void;
}

/**
 * Renders Terminal instances for a single workspace.
 *
 * Each workspace group uses its own Zustand selectors so it only re-renders
 * when its workspace's terminal tabs change — not when other workspaces update.
 * Non-current workspaces are CSS-hidden (visibility:hidden + absolute) to
 * preserve xterm DOM and PTY processes across workspace switches.
 */
function WorkspaceTerminals({
  workspaceId,
  workspacePath,
  isCurrent,
  panelVisible,
  getInitialCommand,
}: {
  workspaceId: string;
  workspacePath: string;
  isCurrent: boolean;
  panelVisible: boolean;
  getInitialCommand: (id: string) => string | undefined;
}) {
  const tabs = useWorkspaceLayoutStore((s) => s.layouts[workspaceId]?.terminalTabs ?? EMPTY_TABS);
  const activeTabId = useWorkspaceLayoutStore(
    (s) => s.layouts[workspaceId]?.activeTerminalTabId ?? null
  );

  return (
    <>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={
            isCurrent && activeTabId === tab.id
              ? "h-full w-full"
              : "pointer-events-none invisible absolute h-full w-full"
          }
        >
          <Terminal
            id={tab.id}
            workspacePath={workspacePath}
            getInitialCommand={getInitialCommand}
            visible={panelVisible && isCurrent && activeTabId === tab.id}
          />
        </div>
      ))}
    </>
  );
}

export function TerminalPanel({
  workspaceId,
  workspacePath,
  panelVisible = true,
  onCollapse,
}: TerminalPanelProps) {
  // Track all visited workspaces so their Terminal components stay mounted
  // across workspace switches, preserving PTY processes and xterm history.
  // Map<workspaceId, workspacePath> — entries accumulate as user visits workspaces.
  const [visitedWorkspaces, setVisitedWorkspaces] = useState<Map<string, string>>(
    () => new Map([[workspaceId, workspacePath]])
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setVisitedWorkspaces((prev) => {
      const next = new Map(prev);

      // Delete + re-insert to move revisited workspace to back (most recent)
      if (next.has(workspaceId)) {
        if (next.get(workspaceId) === workspacePath) {
          // Already at correct path — just move to back for LRU ordering
          next.delete(workspaceId);
          next.set(workspaceId, workspacePath);
          return next;
        }
        next.delete(workspaceId);
      }
      next.set(workspaceId, workspacePath);

      // Evict oldest non-current workspace when over the cap
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

  // Read terminal tab state for the CURRENT workspace (tab bar rendering only)
  const tabs = useWorkspaceLayoutStore((s) => s.layouts[workspaceId]?.terminalTabs ?? EMPTY_TABS);
  const activeTabId = useWorkspaceLayoutStore(
    (s) => s.layouts[workspaceId]?.activeTerminalTabId ?? null
  );
  const nextTerminalNum = useWorkspaceLayoutStore(
    (s) => s.layouts[workspaceId]?.nextTerminalNum ?? 1
  );

  // One-shot initial commands — keyed by globally-unique tab ID (UUID based).
  // Not cleared on workspace switch since old workspace terminals stay mounted.
  const initialCommandsRef = useRef<Map<string, string>>(new Map());
  const getInitialCommand = useCallback((id: string) => initialCommandsRef.current.get(id), []);

  // Ensure at least one terminal tab exists for the current workspace
  useEffect(() => {
    if (tabs.length === 0) {
      const id = `terminal-${crypto.randomUUID()}`;
      workspaceLayoutActions.setTerminalTabState(workspaceId, [{ id, title: "Terminal 1" }], id, 2);
    }
  }, [workspaceId, tabs.length]);

  // Helper to batch-update terminal state in the store
  function updateTabs(
    newTabs: PersistedTerminalTab[],
    newActiveId: string | null,
    newNextNum?: number
  ) {
    workspaceLayoutActions.setTerminalTabState(
      workspaceId,
      newTabs,
      newActiveId,
      newNextNum ?? nextTerminalNum
    );
  }

  // Watch for queued task commands from the task store (e.g. "bun run build" from header buttons)
  const pendingTask = useTerminalTaskStore((s) => s.pendingTask);

  useEffect(() => {
    if (!pendingTask) return;
    const task = consumeTerminalTask();
    if (!task) return;

    // Read fresh state to avoid stale closure over render-time values
    const { terminalTabs, nextTerminalNum: num } = workspaceLayoutActions.getLayout(workspaceId);
    const id = `task-${crypto.randomUUID()}`;
    initialCommandsRef.current.set(id, task.command);
    workspaceLayoutActions.setTerminalTabState(
      workspaceId,
      [...terminalTabs, { id, title: task.title }],
      id,
      num + 1
    );
  }, [pendingTask, workspaceId]);

  // Watch for pending terminal commands from the layout store (e.g. "claude login" from chat error)
  const pendingCommand = useWorkspaceLayoutStore(
    (s) => s.layouts[workspaceId]?.pendingTerminalCommand ?? null
  );

  useEffect(() => {
    if (!pendingCommand) return;

    // Clear immediately to prevent duplicate tabs from rapid clicks
    const cmd = pendingCommand;
    workspaceLayoutActions.setPendingTerminalCommand(workspaceId, null);

    // Read fresh state to avoid stale closure over render-time values
    const { terminalTabs, nextTerminalNum: num } = workspaceLayoutActions.getLayout(workspaceId);
    const id = `terminal-${crypto.randomUUID()}`;
    initialCommandsRef.current.set(id, cmd);
    workspaceLayoutActions.setTerminalTabState(
      workspaceId,
      [...terminalTabs, { id, title: "Login" }],
      id,
      num + 1
    );
  }, [pendingCommand, workspaceId]);

  function addTerminal() {
    const id = `terminal-${crypto.randomUUID()}`;
    updateTabs([...tabs, { id, title: `Terminal ${nextTerminalNum}` }], id, nextTerminalNum + 1);
  }

  function closeTab(tabId: string) {
    const newTabs = tabs.filter((t) => t.id !== tabId);
    let newActiveId = activeTabId;
    if (activeTabId === tabId) {
      newActiveId = newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null;
    }
    initialCommandsRef.current.delete(tabId);
    updateTabs(newTabs, newActiveId);
  }

  return (
    <div className="bg-background flex h-full flex-col">
      {/* Tab bar — shows only the current workspace's tabs */}
      <div className="vibrancy-panel border-border/40 flex h-9 flex-shrink-0 items-center justify-between border-b">
        <div
          className="flex flex-1 items-center gap-1 overflow-x-auto px-2"
          role="tablist"
          aria-label="Terminal tabs"
        >
          {tabs.map((tab) => (
            <TabPill
              key={tab.id}
              active={activeTabId === tab.id}
              icon={<TerminalIcon strokeWidth={1.75} className="h-3.5 w-3.5" />}
              onSelect={() => updateTabs(tabs, tab.id)}
              onClose={() => closeTab(tab.id)}
              closeAriaLabel={`Close ${tab.title}`}
              className="max-w-[150px]"
            >
              {tab.title}
            </TabPill>
          ))}
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="New terminal"
                onClick={addTerminal}
                className="text-text-muted hover:bg-foreground/5 hover:text-text-tertiary flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md border-none bg-transparent transition-[color,background-color,scale] duration-150 ease-out active:scale-[0.96]"
              >
                <Plus strokeWidth={1.75} className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={8}>
              <p className="text-xs">New terminal</p>
            </TooltipContent>
          </Tooltip>
        </div>

        {/* Collapse button on same line as tabs */}
        {onCollapse && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onCollapse}
            className="mr-2 h-5 w-5"
            title="Collapse terminal"
            aria-label="Collapse terminal"
          >
            <ChevronDown className="h-3 w-3" />
          </Button>
        )}
      </div>

      {/* Terminal content — renders ALL visited workspaces' terminals,
          CSS-hiding non-current ones to preserve PTY and xterm state.
          Empty-state placeholder only shows for current workspace. */}
      <div className="relative flex-1 overflow-hidden">
        {tabs.length === 0 && (
          <div className="text-muted-foreground/50 flex h-full items-center justify-center text-xs">
            Click + to open a terminal
          </div>
        )}
        {Array.from(visitedWorkspaces.entries()).map(([wsId, wsPath]) => (
          <WorkspaceTerminals
            key={wsId}
            workspaceId={wsId}
            workspacePath={wsPath}
            isCurrent={wsId === workspaceId}
            panelVisible={panelVisible}
            getInitialCommand={getInitialCommand}
          />
        ))}
      </div>
    </div>
  );
}
