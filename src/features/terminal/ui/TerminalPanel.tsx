import { useState } from 'react';
import { toast } from 'sonner';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
  onCollapse?: () => void;
}

export function TerminalPanel({ workspacePath, workspaceName, onCollapse }: TerminalPanelProps) {
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
        toast.error('No development server detected!', {
          description: (
            <div className="whitespace-pre-wrap">
              {`Please start your dev server first:\n  • Vite: npm run dev (port 5173)\n  • React/Next: npm run dev (port 3000)\n  • Angular: ng serve (port 4200)\n\nThen click Run again.`}
            </div>
          ),
          duration: 5000,
        });
      }
    } catch (error) {
      console.error('Error detecting server:', error);
      toast.error('Error detecting development server. Please check the console.');
    } finally {
      setDetectingServer(false);
    }
  }

  return (
    <div className="flex flex-col h-full bg-background">
      <div className="flex items-center justify-between vibrancy-panel border-b border-border/40 h-[28px] flex-shrink-0">
        <div className="flex items-center gap-0.5 flex-1 overflow-x-auto px-2">
          {showRun && tabs.length === 0 && (
            <div className="flex items-center px-2 py-1 bg-background text-foreground rounded-t text-xs whitespace-nowrap select-none font-medium">
              <span>Run</span>
            </div>
          )}
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`flex items-center gap-1.5 px-2 py-1 rounded-t cursor-pointer text-xs whitespace-nowrap select-none transition-colors duration-200 ease-out ${
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
                className="bg-transparent border-none text-muted-foreground text-sm leading-none p-0 w-3 h-3 flex items-center justify-center cursor-pointer rounded-sm transition-colors duration-200 ease-out hover:bg-muted/80 hover:text-foreground"
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
            className="bg-transparent border-none text-muted-foreground text-sm px-1.5 py-0.5 cursor-pointer rounded transition-colors duration-200 ease-out hover:bg-muted/80 hover:text-foreground"
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
            className="h-5 w-5 mr-2"
            title="Collapse terminal"
          >
            <ChevronDown className="h-3 w-3" />
          </Button>
        )}
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
          <div className="flex flex-col items-center justify-center h-full bg-background px-6">
            <button
              className="group flex items-center gap-2 bg-transparent border border-border/40 rounded-lg px-4 py-2.5 cursor-pointer transition-all duration-200 ease-out hover:border-foreground/40 hover:bg-muted/30 disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={handleRunWorkspace}
              disabled={detectingServer}
            >
              <div className="text-base text-muted-foreground transition-colors duration-200 ease-out group-hover:text-foreground">
                ▶
              </div>
              <div className="text-sm font-medium text-muted-foreground transition-colors duration-200 ease-out group-hover:text-foreground">
                {detectingServer ? 'Detecting server...' : 'Run workspace'}
              </div>
            </button>
          </div>
        ) : (
          tabs.map((tab) => (
            <div
              key={tab.id}
              className={`w-full h-full ${activeTabId === tab.id ? 'block' : 'hidden'}`}
            >
              <Terminal id={tab.id} workspacePath={workspacePath} onClose={() => closeTab(tab.id)} />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
