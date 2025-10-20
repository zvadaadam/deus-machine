import { useState } from 'react';
import { toast } from 'sonner';
import { Terminal } from './Terminal';

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
}

export function TerminalPanel({ workspacePath, workspaceName }: TerminalPanelProps) {
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [showRun, setShowRun] = useState(true);
  const [nextTerminalNum, setNextTerminalNum] = useState(1);
  const [showBrowser, setShowBrowser] = useState(false);
  const [browserUrl, setBrowserUrl] = useState<string>('');
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
          method: 'HEAD',
          mode: 'no-cors', // Allow checking if server exists without CORS
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
    console.log('Run workspace clicked for:', workspaceName);
    setDetectingServer(true);

    try {
      const server = await detectDevServer();

      if (server) {
        console.log(`✅ Detected dev server at ${server.url}`);
        setBrowserUrl(server.url);
        setShowBrowser(true);
        setShowRun(false);
      } else {
        toast.error(
          `No development server detected!\n\n` +
          `Please start your dev server first:\n` +
          `  • Vite: npm run dev (port 5173)\n` +
          `  • React/Next: npm run dev (port 3000)\n` +
          `  • Angular: ng serve (port 4200)\n\n` +
          `Then click Run again.`,
          { duration: 5000 }
        );
      }
    } catch (error) {
      console.error('Error detecting server:', error);
      toast.error('Error detecting development server. Please check the console.');
    } finally {
      setDetectingServer(false);
    }
  }

  return (
    <div className="flex flex-col h-full bg-background border-t border-border">
      <div className="flex items-center justify-between vibrancy-panel border-b border-border h-[35px] flex-shrink-0">
        <div className="flex items-center gap-0.5 flex-1 overflow-x-auto px-1">
          {showRun && tabs.length === 0 && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-background text-foreground rounded-t cursor-pointer text-[13px] whitespace-nowrap select-none font-medium">
              <span>Run</span>
            </div>
          )}
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-t cursor-pointer text-[13px] whitespace-nowrap select-none transition-colors duration-200 ease-out ${
                activeTabId === tab.id
                  ? 'bg-background text-foreground font-medium'
                  : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
              onClick={() => {
                setActiveTabId(tab.id);
                setShowRun(false);
              }}
            >
              <span>{tab.title}</span>
              <button
                className="bg-transparent border-none text-muted-foreground text-lg leading-none p-0 w-4 h-4 flex items-center justify-center cursor-pointer rounded-sm transition-colors duration-200 ease-out hover:bg-muted/80 hover:text-foreground"
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
            className="bg-transparent border-none text-muted-foreground text-lg px-2 py-1 cursor-pointer rounded transition-colors duration-200 ease-out hover:bg-muted/80 hover:text-foreground"
            onClick={addTerminal}
            title="New terminal"
          >
            +
          </button>
        </div>
        <button
          className="flex items-center gap-1 bg-transparent border-none text-muted-foreground px-3 py-1.5 mr-2 cursor-pointer text-[13px] rounded transition-colors duration-200 ease-out whitespace-nowrap hover:bg-muted/80 hover:text-foreground"
          onClick={handleRunWorkspace}
          title="Run workspace (⌘R)"
        >
          ▶ Run <span className="opacity-60 text-[11px]">⌘R</span>
        </button>
      </div>

      <div className="flex-1 overflow-hidden relative">
        {showBrowser ? (
          <div className="w-full h-full flex flex-col bg-background">
            <div className="flex items-center justify-between h-[35px] bg-muted/30 border-b border-border px-3 flex-shrink-0">
              <div className="flex-1 flex items-center bg-background border border-border rounded px-2 py-1 mr-2">
                <span className="text-xs text-muted-foreground font-mono overflow-hidden text-ellipsis whitespace-nowrap">
                  {browserUrl}
                </span>
              </div>
              <button
                className="bg-transparent border-none text-muted-foreground text-xl leading-none p-0 w-6 h-6 flex items-center justify-center cursor-pointer rounded transition-[background-color,color] duration-200 ease-out hover:bg-muted hover:text-foreground"
                onClick={() => {
                  setShowBrowser(false);
                  setShowRun(true);
                  setBrowserUrl('');
                }}
                title="Close browser"
              >
                ×
              </button>
            </div>
            <iframe
              src={browserUrl}
              className="flex-1 w-full h-full border-none bg-background"
              title="Development Server"
              sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
            />
          </div>
        ) : showRun && tabs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full bg-background">
            <button
              className="group flex flex-col items-center justify-center bg-transparent border-2 border-dashed border-border rounded-xl px-12 py-8 cursor-pointer transition-[background-color,border-color] duration-200 ease-out hover:border-primary hover:bg-primary/5 disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={handleRunWorkspace}
              disabled={detectingServer}
            >
              <div className="text-5xl text-muted-foreground mb-2 transition-colors duration-200 ease-out group-hover:text-primary">
                ▶
              </div>
              <div className="text-base font-semibold text-muted-foreground mb-1">
                {detectingServer ? 'Detecting server...' : 'Run workspace'}
              </div>
            </button>
            <div className="mt-4 text-[13px] text-muted-foreground">
              Test your changes here.
            </div>
          </div>
        ) : (
          tabs.map((tab) => (
            <div
              key={tab.id}
              className="w-full h-full"
              style={{ display: activeTabId === tab.id ? 'block' : 'none' }}
            >
              <Terminal id={tab.id} workspacePath={workspacePath} onClose={() => closeTab(tab.id)} />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
