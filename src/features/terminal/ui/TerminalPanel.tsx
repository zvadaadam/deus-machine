import { useState, useEffect } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTerminalTaskStore, consumeTerminalTask } from "../store/terminalTaskStore";
import { useWorkspaceLayoutStore, workspaceLayoutActions } from "@/features/workspace/store";
import { Terminal } from "./Terminal";

interface TerminalTab {
  id: string;
  title: string;
  initialCommand?: string;
}

interface TerminalPanelProps {
  workspaceId: string;
  workspacePath: string;
  onCollapse?: () => void;
}

export function TerminalPanel({ workspaceId, workspacePath, onCollapse }: TerminalPanelProps) {
  const [initialTab] = useState<TerminalTab>(() => ({
    id: `terminal-${Date.now()}`,
    title: "Terminal 1",
  }));
  const [tabs, setTabs] = useState<TerminalTab[]>(() => [initialTab]);
  const [activeTabId, setActiveTabId] = useState<string | null>(() => initialTab.id);
  const [nextTerminalNum, setNextTerminalNum] = useState(2);

  // Watch for queued task commands from the task store (e.g. "bun run build" from header buttons)
  const pendingTask = useTerminalTaskStore((s) => s.pendingTask);

  useEffect(() => {
    if (!pendingTask) return;
    const task = consumeTerminalTask();
    if (!task) return;

    const id = `task-${Date.now()}`;
    const newTab: TerminalTab = {
      id,
      title: task.title,
      initialCommand: task.command,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(id);
    setNextTerminalNum((n) => n + 1);
  }, [pendingTask]);

  // Watch for pending terminal commands from the layout store (e.g. "claude login" from chat error)
  const pendingCommand = useWorkspaceLayoutStore(
    (s) => s.layouts[workspaceId]?.pendingTerminalCommand ?? null
  );

  useEffect(() => {
    if (!pendingCommand) return;

    // Clear immediately to prevent duplicate tabs from rapid clicks
    const cmd = pendingCommand;
    workspaceLayoutActions.setPendingTerminalCommand(workspaceId, null);

    const id = `terminal-${Date.now()}`;
    const newTab: TerminalTab = {
      id,
      title: "Login",
      initialCommand: cmd,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(id);
    setNextTerminalNum((n) => n + 1);
  }, [pendingCommand, workspaceId]);

  function addTerminal() {
    const id = `terminal-${Date.now()}`;
    const newTab: TerminalTab = {
      id,
      title: `Terminal ${nextTerminalNum}`,
    };
    setTabs([...tabs, newTab]);
    setActiveTabId(id);
    setNextTerminalNum(nextTerminalNum + 1);
  }

  function closeTab(tabId: string) {
    const newTabs = tabs.filter((t) => t.id !== tabId);
    setTabs(newTabs);

    if (activeTabId === tabId) {
      if (newTabs.length > 0) {
        setActiveTabId(newTabs[newTabs.length - 1].id);
      } else {
        setActiveTabId(null);
      }
    }
  }

  return (
    <div className="bg-background flex h-full flex-col">
      <div className="vibrancy-panel border-border/40 flex h-9 flex-shrink-0 items-center justify-between border-b">
        <div className="flex flex-1 items-center gap-0.5 overflow-x-auto px-2">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`flex cursor-pointer items-center gap-1.5 rounded-t px-2 py-1 text-xs whitespace-nowrap transition-colors duration-200 ease-out select-none ${
                activeTabId === tab.id
                  ? "bg-background text-foreground font-medium"
                  : "bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
              onClick={() => setActiveTabId(tab.id)}
            >
              <span>{tab.title}</span>
              <button
                className="text-muted-foreground hover:bg-muted/80 hover:text-foreground flex h-3 w-3 cursor-pointer items-center justify-center rounded-sm border-none bg-transparent p-0 text-sm leading-none transition-colors duration-200 ease-out"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id);
                }}
              >
                ×
              </button>
            </div>
          ))}
          <button
            className="text-muted-foreground hover:bg-muted/80 hover:text-foreground cursor-pointer rounded border-none bg-transparent px-1.5 py-0.5 text-sm transition-colors duration-200 ease-out"
            onClick={addTerminal}
            title="New terminal"
          >
            +
          </button>
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

      <div className="relative flex-1 overflow-hidden">
        {tabs.length === 0 ? (
          <div className="text-muted-foreground/50 flex h-full items-center justify-center text-xs">
            Click + to open a terminal
          </div>
        ) : (
          tabs.map((tab) => (
            <div
              key={tab.id}
              className={`h-full w-full ${activeTabId === tab.id ? "block" : "hidden"}`}
            >
              <Terminal id={tab.id} workspacePath={workspacePath} initialCommand={tab.initialCommand} />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
