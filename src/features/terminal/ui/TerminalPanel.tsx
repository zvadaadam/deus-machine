import { useState } from "react";
import { toast } from "sonner";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Terminal } from "./Terminal";

interface DevServer {
  url: string;
  port: number;
  detected: boolean;
}

interface TerminalTab {
  id: string;
  title: string;
}

interface TerminalPanelProps {
  workspacePath: string;
  workspaceName: string;
  onCollapse?: () => void;
}

export function TerminalPanel({ workspacePath, workspaceName, onCollapse }: TerminalPanelProps) {
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [showRun, setShowRun] = useState(true);
  const [nextTerminalNum, setNextTerminalNum] = useState(1);
  const [showBrowser, setShowBrowser] = useState(false);
  const [browserUrl, setBrowserUrl] = useState<string>("");
  const [detectingServer, setDetectingServer] = useState(false);

  function addTerminal() {
    const id = `terminal-${Date.now()}`;
    const newTab: TerminalTab = {
      id,
      title: `Terminal ${nextTerminalNum}`,
    };
    setTabs([...tabs, newTab]);
    setActiveTabId(id);
    setShowRun(false);
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
        setShowRun(true);
      }
    }
  }

  async function detectDevServer(): Promise<DevServer | null> {
    // Common dev server ports to check
    const commonPorts = [5173, 3000, 8080, 4200, 8000, 5000, 3001];

    for (const port of commonPorts) {
      try {
        await fetch(`http://localhost:${port}`, {
          method: "HEAD",
          mode: "no-cors", // Allow checking if server exists without CORS
        });
        // If we get here without error, server is running
        return {
          url: `http://localhost:${port}`,
          port,
          detected: true,
        };
      } catch (error) {
        // Server not found on this port, continue
        continue;
      }
    }

    return null;
  }

  async function handleRunWorkspace() {
    console.log("Run workspace clicked for:", workspaceName);
    setDetectingServer(true);

    try {
      const server = await detectDevServer();

      if (server) {
        console.log(`✅ Detected dev server at ${server.url}`);
        setBrowserUrl(server.url);
        setShowBrowser(true);
        setShowRun(false);
      } else {
        toast.error("No development server detected!", {
          description: (
            <div style={{ whiteSpace: "pre-wrap" }}>
              {`Please start your dev server first:\n  • Vite: npm run dev (port 5173)\n  • React/Next: npm run dev (port 3000)\n  • Angular: ng serve (port 4200)\n\nThen click Run again.`}
            </div>
          ),
          duration: 5000,
        });
      }
    } catch (error) {
      console.error("Error detecting server:", error);
      toast.error("Error detecting development server. Please check the console.");
    } finally {
      setDetectingServer(false);
    }
  }

  return (
    <div className="bg-background flex h-full flex-col">
      <div className="vibrancy-panel border-border/40 flex h-[28px] flex-shrink-0 items-center justify-between border-b">
        <div className="flex flex-1 items-center gap-0.5 overflow-x-auto px-2">
          {showRun && tabs.length === 0 && (
            <div className="bg-background text-foreground flex items-center rounded-t px-2 py-1 text-[11px] font-medium whitespace-nowrap select-none">
              <span>Run</span>
            </div>
          )}
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`flex cursor-pointer items-center gap-1.5 rounded-t px-2 py-1 text-[11px] whitespace-nowrap transition-colors duration-200 ease-out select-none ${
                activeTabId === tab.id
                  ? "bg-background text-foreground font-medium"
                  : "bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
              onClick={() => {
                setActiveTabId(tab.id);
                setShowRun(false);
              }}
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
          >
            <ChevronDown className="h-3 w-3" />
          </Button>
        )}
      </div>

      <div className="relative flex-1 overflow-hidden">
        {showBrowser ? (
          <div className="bg-background flex h-full w-full flex-col">
            <div className="bg-muted/30 border-border flex h-[35px] flex-shrink-0 items-center justify-between border-b px-3">
              <div className="bg-background border-border mr-2 flex flex-1 items-center rounded border px-2 py-1">
                <span className="text-muted-foreground overflow-hidden font-mono text-xs text-ellipsis whitespace-nowrap">
                  {browserUrl}
                </span>
              </div>
              <button
                className="text-muted-foreground hover:bg-muted hover:text-foreground flex h-6 w-6 cursor-pointer items-center justify-center rounded border-none bg-transparent p-0 text-xl leading-none transition-[background-color,color] duration-200 ease-out"
                onClick={() => {
                  setShowBrowser(false);
                  setShowRun(true);
                  setBrowserUrl("");
                }}
                title="Close browser"
              >
                ×
              </button>
            </div>
            <iframe
              src={browserUrl}
              className="bg-background h-full w-full flex-1 border-none"
              title="Development Server"
              sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
            />
          </div>
        ) : showRun && tabs.length === 0 ? (
          <div className="bg-background flex h-full flex-col items-center justify-center px-6">
            <button
              className="group border-border/40 hover:border-foreground/40 hover:bg-muted/30 flex cursor-pointer items-center gap-2 rounded-lg border bg-transparent px-4 py-2.5 transition-all duration-200 ease-out disabled:cursor-not-allowed disabled:opacity-50"
              onClick={handleRunWorkspace}
              disabled={detectingServer}
            >
              <div className="text-muted-foreground group-hover:text-foreground text-base transition-colors duration-200 ease-out">
                ▶
              </div>
              <div className="text-muted-foreground group-hover:text-foreground text-sm font-medium transition-colors duration-200 ease-out">
                {detectingServer ? "Detecting server..." : "Run workspace"}
              </div>
            </button>
          </div>
        ) : (
          tabs.map((tab) => (
            <div
              key={tab.id}
              className="h-full w-full"
              style={{ display: activeTabId === tab.id ? "block" : "none" }}
            >
              <Terminal
                id={tab.id}
                workspacePath={workspacePath}
                onClose={() => closeTab(tab.id)}
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
